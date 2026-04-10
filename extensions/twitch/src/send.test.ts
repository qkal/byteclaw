/**
 * Tests for send.ts module
 *
 * Tests cover:
 * - Message sending with valid configuration
 * - Account resolution and validation
 * - Channel normalization
 * - Markdown stripping
 * - Error handling for missing/invalid accounts
 * - Registry integration
 */

import { describe, expect, it, vi } from "vitest";
import { getClientManager } from "./client-manager-registry.js";
import { resolveTwitchAccountContext } from "./config.js";
import { sendMessageTwitchInternal } from "./send.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig,
} from "./test-fixtures.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";

// Mock dependencies
vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

vi.mock("./utils/twitch.js", () => ({
  generateMessageId: vi.fn(() => "test-msg-id"),
  normalizeTwitchChannel: (channel: string) => channel.toLowerCase().replace(/^#/, ""),
}));

vi.mock("./utils/markdown.js", () => ({
  stripMarkdownForTwitch: vi.fn((text: string) => text.replace(/\*\*/g, "")),
}));

vi.mock("./client-manager-registry.js", () => ({
  getClientManager: vi.fn(),
}));

describe("send", () => {
  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  const mockAccount = {
    ...BASE_TWITCH_TEST_ACCOUNT,
    accessToken: "test123",
  };

  const mockConfig = makeTwitchTestConfig(mockAccount);
  installTwitchTestHooks();

  describe("sendMessageTwitchInternal", () => {
    function setupAccountContext(params?: {
      account?: typeof mockAccount | null;
      configured?: boolean;
      availableAccountIds?: string[];
    }) {
      const account = params?.account === undefined ? mockAccount : params.account;
      vi.mocked(resolveTwitchAccountContext).mockImplementation((_cfg, accountId) => ({
        account,
        accountId: accountId?.trim() || "default",
        availableAccountIds: params?.availableAccountIds ?? ["default"],
        configured: account ? (params?.configured ?? true) : false,
        tokenResolution: { source: "config", token: account?.accessToken ?? "" },
      }));
    }

    async function mockSuccessfulSend(params: {
      messageId: string;
      stripMarkdown?: (text: string) => string;
    }) {
      setupAccountContext();
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockResolvedValue({
          messageId: params.messageId,
          ok: true,
        }),
      } as unknown as ReturnType<typeof getClientManager>);
      vi.mocked(stripMarkdownForTwitch).mockImplementation(
        params.stripMarkdown ?? ((text) => text),
      );

      return { stripMarkdownForTwitch };
    }

    it("should send a message successfully", async () => {
      await mockSuccessfulSend({ messageId: "twitch-msg-123" });

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello Twitch!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("twitch-msg-123");
    });

    it("should strip markdown when enabled", async () => {
      const { stripMarkdownForTwitch } = await mockSuccessfulSend({
        messageId: "twitch-msg-456",
        stripMarkdown: (text) => text.replace(/\*\*/g, ""),
      });

      await sendMessageTwitchInternal(
        "#testchannel",
        "**Bold** text",
        mockConfig,
        "default",
        true,
        mockLogger as unknown as Console,
      );

      expect(stripMarkdownForTwitch).toHaveBeenCalledWith("**Bold** text");
    });

    it("should return error when account not found", async () => {
      setupAccountContext({ account: null });

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "nonexistent",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Account not found: nonexistent");
    });

    it("should return error when account not configured", async () => {
      setupAccountContext({ configured: false });

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("not properly configured");
    });

    it("should return error when no channel specified", async () => {
      // Set channel to undefined to trigger the error (bypassing type check)
      const accountWithoutChannel = {
        ...mockAccount,
        channel: undefined as unknown as string,
      };
      setupAccountContext({ account: accountWithoutChannel });

      const result = await sendMessageTwitchInternal(
        "",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("No channel specified");
    });

    it("should skip sending empty message after markdown stripping", async () => {
      setupAccountContext();
      vi.mocked(stripMarkdownForTwitch).mockReturnValue("");

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "**Only markdown**",
        mockConfig,
        "default",
        true,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("skipped");
    });

    it("should return error when client manager not found", async () => {
      setupAccountContext();
      vi.mocked(getClientManager).mockReturnValue(undefined);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Client manager not found");
    });

    it("should handle send errors gracefully", async () => {
      setupAccountContext();
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockRejectedValue(new Error("Connection lost")),
      } as unknown as ReturnType<typeof getClientManager>);

      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Connection lost");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should use account channel when channel parameter is empty", async () => {
      setupAccountContext();
      const mockSend = vi.fn().mockResolvedValue({
        messageId: "twitch-msg-789",
        ok: true,
      });
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: mockSend,
      } as unknown as ReturnType<typeof getClientManager>);

      await sendMessageTwitchInternal(
        "",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger as unknown as Console,
      );

      expect(mockSend).toHaveBeenCalledWith(
        mockAccount,
        "testchannel", // Normalized account channel
        "Hello!",
        mockConfig,
        "default",
      );
    });

    it("uses the configured default account when accountId is omitted", async () => {
      const secondaryAccount = {
        ...mockAccount,
        channel: "secondary-channel",
        username: "secondary-user",
      };
      vi.mocked(resolveTwitchAccountContext).mockImplementation((_cfg, accountId) => ({
        account: secondaryAccount,
        accountId: accountId?.trim() || "secondary",
        availableAccountIds: ["default", "secondary"],
        configured: true,
        tokenResolution: { source: "config", token: secondaryAccount.accessToken ?? "" },
      }));
      const mockSend = vi.fn().mockResolvedValue({
        messageId: "twitch-msg-secondary",
        ok: true,
      });
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: mockSend,
      } as unknown as ReturnType<typeof getClientManager>);

      const result = await sendMessageTwitchInternal(
        "",
        "Hello!",
        {
          channels: {
            twitch: {
              defaultAccount: "secondary",
            },
          },
        } as never,
        undefined,
        false,
        mockLogger as unknown as Console,
      );

      expect(result.ok).toBe(true);
      expect(getClientManager).toHaveBeenCalledWith("secondary");
      expect(mockSend).toHaveBeenCalledWith(
        secondaryAccount,
        "secondary-channel",
        "Hello!",
        expect.any(Object),
        "secondary",
      );
    });
  });
});
