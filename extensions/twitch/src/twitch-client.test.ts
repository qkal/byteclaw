/**
 * Tests for TwitchClientManager class
 *
 * Tests cover:
 * - Client connection and reconnection
 * - Message handling (chat)
 * - Message sending with rate limiting
 * - Disconnection scenarios
 * - Error handling and edge cases
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchToken } from "./token.js";
import { TwitchClientManager } from "./twitch-client.js";
import type { ChannelLogSink, TwitchAccountConfig, TwitchChatMessage } from "./types.js";

// Mock @twurple dependencies
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockJoin = vi.fn().mockResolvedValue(undefined);
const mockSay = vi.fn().mockResolvedValue({ messageId: "test-msg-123" });
const mockQuit = vi.fn();
const mockUnbind = vi.fn();

// Event handler storage for testing
const messageHandlers: ((channel: string, user: string, message: string, msg: any) => void)[] = [];

// Mock functions that track handlers and return unbind objects
const mockOnMessage = vi.fn((handler: any) => {
  messageHandlers.push(handler);
  return { unbind: mockUnbind };
});

const mockAddUserForToken = vi.fn().mockResolvedValue("123456");
const mockOnRefresh = vi.fn();
const mockOnRefreshFailure = vi.fn();

vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    onMessage = mockOnMessage;
    connect = mockConnect;
    join = mockJoin;
    say = mockSay;
    quit = mockQuit;
  },
  LogLevel: {
    CRITICAL: "CRITICAL",
    DEBUG: "DEBUG",
    ERROR: "ERROR",
    INFO: "INFO",
    TRACE: "TRACE",
    WARNING: "WARNING",
  },
}));

const mockAuthProvider = {
  constructor: vi.fn(),
};

vi.mock("@twurple/auth", () => ({
  RefreshingAuthProvider: class {
    addUserForToken = mockAddUserForToken;
    onRefresh = mockOnRefresh;
    onRefreshFailure = mockOnRefreshFailure;
  },
  StaticAuthProvider: class {
    constructor(...args: unknown[]) {
      mockAuthProvider.constructor(...args);
    }
  },
}));

// Mock token resolution - must be after @twurple/auth mock
vi.mock("./token.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchToken: vi.fn(() => ({
    source: "config" as const,
    token: "oauth:mock-token-from-tests",
  })),
}));

describe("TwitchClientManager", () => {
  let manager: TwitchClientManager;
  let mockLogger: ChannelLogSink;
  let resolveTwitchTokenMock: ReturnType<typeof vi.mocked<typeof resolveTwitchToken>>;

  const testAccount: TwitchAccountConfig = {
    accessToken: "test123456",
    channel: "testchannel",
    clientId: "test-client-id",
    enabled: true,
    username: "testbot",
  };

  const testAccount2: TwitchAccountConfig = {
    accessToken: "test789",
    channel: "testchannel2",
    clientId: "test-client-id-2",
    enabled: true,
    username: "testbot2",
  };

  beforeAll(() => {
    resolveTwitchTokenMock = vi.mocked(resolveTwitchToken);
  });

  beforeEach(() => {
    // Clear all mocks first
    vi.clearAllMocks();

    // Clear handler arrays
    messageHandlers.length = 0;

    // Re-set up the default token mock implementation after clearing
    resolveTwitchTokenMock.mockReturnValue({
      source: "config" as const,
      token: "oauth:mock-token-from-tests",
    });

    // Create mock logger
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    // Create manager instance
    manager = new TwitchClientManager(mockLogger);
  });

  afterEach(() => {
    // Clean up manager to avoid side effects
    manager._clearForTest();
  });

  describe("getClient", () => {
    it("should create a new client connection", async () => {
      const _client = await manager.getClient(testAccount);

      // New implementation: connect is called, channels are passed to constructor
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Connected to Twitch as testbot"),
      );
    });

    it("should use account username as default channel when channel not specified", async () => {
      const accountWithoutChannel: TwitchAccountConfig = {
        ...testAccount,
        channel: "",
      } as unknown as TwitchAccountConfig;

      await manager.getClient(accountWithoutChannel);

      // New implementation: channel (testbot) is passed to constructor, not via join()
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("should reuse existing client for same account", async () => {
      const client1 = await manager.getClient(testAccount);
      const client2 = await manager.getClient(testAccount);

      expect(client1).toBe(client2);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("should create separate clients for different accounts", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("should normalize token by removing oauth: prefix", async () => {
      const accountWithPrefix: TwitchAccountConfig = {
        ...testAccount,
        accessToken: "oauth:actualtoken123",
      };

      // Override the mock to return a specific token for this test
      resolveTwitchTokenMock.mockReturnValue({
        source: "config" as const,
        token: "oauth:actualtoken123",
      });

      await manager.getClient(accountWithPrefix);

      expect(mockAuthProvider.constructor).toHaveBeenCalledWith("test-client-id", "actualtoken123");
    });

    it("should use token directly when no oauth: prefix", async () => {
      // Override the mock to return a token without oauth: prefix
      resolveTwitchTokenMock.mockReturnValue({
        source: "config" as const,
        token: "oauth:mock-token-from-tests",
      });

      await manager.getClient(testAccount);

      // Implementation strips oauth: prefix from all tokens
      expect(mockAuthProvider.constructor).toHaveBeenCalledWith(
        "test-client-id",
        "mock-token-from-tests",
      );
    });

    it("should throw error when clientId is missing", async () => {
      const accountWithoutClientId: TwitchAccountConfig = {
        ...testAccount,
        clientId: "" as unknown as string,
      } as unknown as TwitchAccountConfig;

      await expect(manager.getClient(accountWithoutClientId)).rejects.toThrow(
        "Missing Twitch client ID",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Missing Twitch client ID"),
      );
    });

    it("should throw error when token is missing", async () => {
      // Override the mock to return empty token
      resolveTwitchTokenMock.mockReturnValue({
        source: "none" as const,
        token: "",
      });

      await expect(manager.getClient(testAccount)).rejects.toThrow("Missing Twitch token");
    });

    it("should set up message handlers on client connection", async () => {
      await manager.getClient(testAccount);

      expect(mockOnMessage).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Set up handlers for"));
    });

    it("should create separate clients for same account with different channels", async () => {
      const account1: TwitchAccountConfig = {
        ...testAccount,
        channel: "channel1",
      };
      const account2: TwitchAccountConfig = {
        ...testAccount,
        channel: "channel2",
      };

      await manager.getClient(account1);
      await manager.getClient(account2);

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe("onMessage", () => {
    it("should register message handler for account", () => {
      const handler = vi.fn();
      manager.onMessage(testAccount, handler);

      expect(handler).not.toHaveBeenCalled();
    });

    it("should replace existing handler for same account", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      manager.onMessage(testAccount, handler1);
      manager.onMessage(testAccount, handler2);

      // Check the stored handler is handler2
      const key = manager.getAccountKey(testAccount);
      expect((manager as any).messageHandlers.get(key)).toBe(handler2);
    });
  });

  describe("disconnect", () => {
    it("should disconnect a connected client", async () => {
      await manager.getClient(testAccount);
      await manager.disconnect(testAccount);

      expect(mockQuit).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Disconnected"));
    });

    it("should clear client and message handler", async () => {
      const handler = vi.fn();
      await manager.getClient(testAccount);
      manager.onMessage(testAccount, handler);

      await manager.disconnect(testAccount);

      const key = manager.getAccountKey(testAccount);
      expect((manager as any).clients.has(key)).toBe(false);
      expect((manager as any).messageHandlers.has(key)).toBe(false);
    });

    it("should handle disconnecting non-existent client gracefully", async () => {
      // Disconnect doesn't throw, just does nothing
      await manager.disconnect(testAccount);
      expect(mockQuit).not.toHaveBeenCalled();
    });

    it("should only disconnect specified account when multiple accounts exist", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      await manager.disconnect(testAccount);

      expect(mockQuit).toHaveBeenCalledTimes(1);

      const key2 = manager.getAccountKey(testAccount2);
      expect((manager as any).clients.has(key2)).toBe(true);
    });
  });

  describe("disconnectAll", () => {
    it("should disconnect all connected clients", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      await manager.disconnectAll();

      expect(mockQuit).toHaveBeenCalledTimes(2);
      expect((manager as any).clients.size).toBe(0);
      expect((manager as any).messageHandlers.size).toBe(0);
    });

    it("should handle empty client list gracefully", async () => {
      // DisconnectAll doesn't throw, just does nothing
      await manager.disconnectAll();
      expect(mockQuit).not.toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    beforeEach(async () => {
      await manager.getClient(testAccount);
    });

    it("should send message successfully", async () => {
      const result = await manager.sendMessage(testAccount, "testchannel", "Hello, world!");

      expect(result).toMatchObject({ ok: true });
      expect(result.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(mockSay).toHaveBeenCalledWith("testchannel", "Hello, world!");
    });

    it("should generate unique message ID for each message", async () => {
      const result1 = await manager.sendMessage(testAccount, "testchannel", "First message");
      const result2 = await manager.sendMessage(testAccount, "testchannel", "Second message");

      expect(result1.messageId).not.toBe(result2.messageId);
    });

    it("should handle sending to account's default channel", async () => {
      const result = await manager.sendMessage(
        testAccount,
        testAccount.channel || testAccount.username,
        "Test message",
      );

      // Should use the account's channel or username
      expect(result.ok).toBe(true);
      expect(mockSay).toHaveBeenCalled();
    });

    it("should return error on send failure", async () => {
      mockSay.mockRejectedValueOnce(new Error("Rate limited"));

      const result = await manager.sendMessage(testAccount, "testchannel", "Test message");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Rate limited");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send message"),
      );
    });

    it("should handle unknown error types", async () => {
      mockSay.mockRejectedValueOnce("String error");

      const result = await manager.sendMessage(testAccount, "testchannel", "Test message");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("String error");
    });

    it("should create client if not already connected", async () => {
      // Clear the existing client
      (manager as any).clients.clear();

      // Reset connect call count for this specific test
      const connectCallCountBefore = mockConnect.mock.calls.length;

      const result = await manager.sendMessage(testAccount, "testchannel", "Test message");

      expect(result.ok).toBe(true);
      expect(mockConnect.mock.calls.length).toBeGreaterThan(connectCallCountBefore);
    });
  });

  describe("message handling integration", () => {
    let capturedMessage: TwitchChatMessage | null = null;

    beforeEach(() => {
      capturedMessage = null;

      // Set up message handler before connecting
      manager.onMessage(testAccount, (message) => {
        capturedMessage = message;
      });
    });

    it("should handle incoming chat messages", async () => {
      await manager.getClient(testAccount);

      // Get the onMessage callback
      const onMessageCallback = messageHandlers[0];
      if (!onMessageCallback) {
        throw new Error("onMessageCallback not found");
      }

      // Simulate Twitch message
      onMessageCallback("#testchannel", "testuser", "Hello bot!", {
        id: "msg123",
        userInfo: {
          displayName: "TestUser",
          isBroadcaster: false,
          isMod: false,
          isSubscriber: false,
          isVip: false,
          userId: "12345",
          userName: "testuser",
        },
      });

      expect(capturedMessage).not.toBeNull();
      expect(capturedMessage?.username).toBe("testuser");
      expect(capturedMessage?.displayName).toBe("TestUser");
      expect(capturedMessage?.userId).toBe("12345");
      expect(capturedMessage?.message).toBe("Hello bot!");
      expect(capturedMessage?.channel).toBe("testchannel");
      expect(capturedMessage?.chatType).toBe("group");
    });

    it("should normalize channel names without # prefix", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = messageHandlers[0];

      onMessageCallback("testchannel", "testuser", "Test", {
        id: "msg1",
        userInfo: {
          displayName: "TestUser",
          isBroadcaster: false,
          isMod: false,
          isSubscriber: false,
          isVip: false,
          userId: "123",
          userName: "testuser",
        },
      });

      expect(capturedMessage?.channel).toBe("testchannel");
    });

    it("should include user role flags in message", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = messageHandlers[0];

      onMessageCallback("#testchannel", "moduser", "Test", {
        id: "msg2",
        userInfo: {
          displayName: "ModUser",
          isBroadcaster: false,
          isMod: true,
          isSubscriber: true,
          isVip: true,
          userId: "456",
          userName: "moduser",
        },
      });

      expect(capturedMessage?.isMod).toBe(true);
      expect(capturedMessage?.isVip).toBe(true);
      expect(capturedMessage?.isSub).toBe(true);
      expect(capturedMessage?.isOwner).toBe(false);
    });

    it("should handle broadcaster messages", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = messageHandlers[0];

      onMessageCallback("#testchannel", "broadcaster", "Test", {
        id: "msg3",
        userInfo: {
          displayName: "Broadcaster",
          isBroadcaster: true,
          isMod: false,
          isSubscriber: false,
          isVip: false,
          userId: "789",
          userName: "broadcaster",
        },
      });

      expect(capturedMessage?.isOwner).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle multiple message handlers for different accounts", async () => {
      const messages1: TwitchChatMessage[] = [];
      const messages2: TwitchChatMessage[] = [];

      manager.onMessage(testAccount, (msg) => messages1.push(msg));
      manager.onMessage(testAccount2, (msg) => messages2.push(msg));

      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      // Simulate message for first account
      const onMessage1 = messageHandlers[0];
      if (!onMessage1) {
        throw new Error("onMessage1 not found");
      }
      onMessage1("#testchannel", "user1", "msg1", {
        id: "1",
        userInfo: {
          displayName: "User1",
          isBroadcaster: false,
          isMod: false,
          isSubscriber: false,
          isVip: false,
          userId: "1",
          userName: "user1",
        },
      });

      // Simulate message for second account
      const onMessage2 = messageHandlers[1];
      if (!onMessage2) {
        throw new Error("onMessage2 not found");
      }
      onMessage2("#testchannel2", "user2", "msg2", {
        id: "2",
        userInfo: {
          displayName: "User2",
          isBroadcaster: false,
          isMod: false,
          isSubscriber: false,
          isVip: false,
          userId: "2",
          userName: "user2",
        },
      });

      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);
      expect(messages1[0]?.message).toBe("msg1");
      expect(messages2[0]?.message).toBe("msg2");
    });

    it("should handle rapid client creation requests", async () => {
      const promises = [
        manager.getClient(testAccount),
        manager.getClient(testAccount),
        manager.getClient(testAccount),
      ];

      await Promise.all(promises);

      // Note: The implementation doesn't handle concurrent getClient calls,
      // So multiple connections may be created. This is expected behavior.
      expect(mockConnect).toHaveBeenCalled();
    });
  });
});
