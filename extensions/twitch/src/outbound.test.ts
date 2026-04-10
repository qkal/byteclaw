/**
 * Tests for outbound.ts module
 *
 * Tests cover:
 * - resolveTarget with various modes (explicit, implicit, heartbeat)
 * - sendText with markdown stripping
 * - sendMedia delegation to sendText
 * - Error handling for missing accounts/channels
 * - Abort signal handling
 */

import { describe, expect, it, vi } from "vitest";
import { resolveTwitchAccountContext } from "./config.js";
import { twitchOutbound } from "./outbound.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig,
} from "./test-fixtures.js";

// Mock dependencies
vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageTwitchInternal: vi.fn(),
}));

vi.mock("./utils/markdown.js", () => ({
  chunkTextForTwitch: vi.fn((text) => text.split(/(.{500})/).filter(Boolean)),
}));

vi.mock("./utils/twitch.js", () => ({
  missingTargetError: (channel: string, hint: string) =>
    new Error(`Missing target for ${channel}. Provide ${hint}`),
  normalizeTwitchChannel: (channel: string) => channel.toLowerCase().replace(/^#/, ""),
}));

function assertResolvedTarget(
  result: ReturnType<NonNullable<typeof twitchOutbound.resolveTarget>>,
): string {
  if (!result.ok) {
    throw result.error;
  }
  return result.to;
}

function expectTargetError(
  resolveTarget: NonNullable<typeof twitchOutbound.resolveTarget>,
  params: Parameters<NonNullable<typeof twitchOutbound.resolveTarget>>[0],
  expectedMessage: string,
) {
  const result = resolveTarget(params);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolveTarget to fail");
  }
  expect(result.error.message).toContain(expectedMessage);
}

describe("outbound", () => {
  const mockAccount = {
    ...BASE_TWITCH_TEST_ACCOUNT,
    accessToken: "oauth:test123",
  };
  const resolveTarget = twitchOutbound.resolveTarget!;

  const mockConfig = makeTwitchTestConfig(mockAccount);
  installTwitchTestHooks();

  function setupAccountContext(params?: {
    account?: typeof mockAccount | null;
    availableAccountIds?: string[];
  }) {
    const account = params?.account === undefined ? mockAccount : params.account;
    vi.mocked(resolveTwitchAccountContext).mockImplementation((_cfg, accountId) => ({
      account,
      accountId: accountId?.trim() || "default",
      availableAccountIds: params?.availableAccountIds ?? ["default"],
      configured: account !== null,
      tokenResolution: { source: "config", token: account?.accessToken ?? "" },
    }));
  }

  describe("metadata", () => {
    it("should have direct delivery mode", () => {
      expect(twitchOutbound.deliveryMode).toBe("direct");
    });

    it("should have 500 character text chunk limit", () => {
      expect(twitchOutbound.textChunkLimit).toBe(500);
    });

    it("should chunk long messages at 500 characters", () => {
      const {chunker} = twitchOutbound;
      if (!chunker) {
        throw new Error("twitch outbound.chunker unavailable");
      }

      expect(chunker("a".repeat(600), 500)).toEqual(["a".repeat(500), "a".repeat(100)]);
    });
  });

  describe("resolveTarget", () => {
    it("should normalize and return target in explicit mode", () => {
      const result = resolveTarget({
        allowFrom: [],
        mode: "explicit",
        to: "#MyChannel",
      });

      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("mychannel");
    });

    it("should return target in implicit mode with wildcard allowlist", () => {
      const result = resolveTarget({
        allowFrom: ["*"],
        mode: "implicit",
        to: "#AnyChannel",
      });

      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("anychannel");
    });

    it("should return target in implicit mode when in allowlist", () => {
      const result = resolveTarget({
        allowFrom: ["#allowed", "#other"],
        mode: "implicit",
        to: "#allowed",
      });

      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("allowed");
    });

    it("should error when target not in allowlist (implicit mode)", () => {
      expectTargetError(
        resolveTarget,
        {
          allowFrom: ["#primary", "#secondary"],
          mode: "implicit",
          to: "#notallowed",
        },
        "Twitch",
      );
    });

    it("should accept any target when allowlist is empty", () => {
      const result = resolveTarget({
        allowFrom: [],
        mode: "heartbeat",
        to: "#anychannel",
      });

      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("anychannel");
    });

    it("should error when no target provided with allowlist", () => {
      expectTargetError(
        resolveTarget,
        {
          allowFrom: ["#fallback", "#other"],
          mode: "implicit",
          to: undefined,
        },
        "Twitch",
      );
    });

    it("should return error when no target and no allowlist", () => {
      expectTargetError(
        resolveTarget,
        {
          allowFrom: [],
          mode: "explicit",
          to: undefined,
        },
        "Missing target",
      );
    });

    it("should handle whitespace-only target", () => {
      expectTargetError(
        resolveTarget,
        {
          allowFrom: [],
          mode: "explicit",
          to: "   ",
        },
        "Missing target",
      );
    });

    it("should error when target normalizes to empty string", () => {
      expectTargetError(
        resolveTarget,
        {
          allowFrom: [],
          mode: "explicit",
          to: "#",
        },
        "Twitch",
      );
    });

    it("should filter wildcard from allowlist when checking membership", () => {
      const result = resolveTarget({
        allowFrom: ["*", "#specific"],
        mode: "implicit",
        to: "#mychannel",
      });

      // With wildcard, any target is accepted
      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("mychannel");
    });
  });

  describe("sendText", () => {
    it("should send message successfully", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "twitch-msg-123",
        ok: true,
      });

      const result = await twitchOutbound.sendText!({
        accountId: "default",
        cfg: mockConfig,
        text: "Hello Twitch!",
        to: "#testchannel",
      });

      expect(result.channel).toBe("twitch");
      expect(result.messageId).toBe("twitch-msg-123");
      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        "testchannel",
        "Hello Twitch!",
        mockConfig,
        "default",
        true,
        console,
      );
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("should throw when account not found", async () => {
      setupAccountContext({ account: null });

      await expect(
        twitchOutbound.sendText!({
          accountId: "nonexistent",
          cfg: mockConfig,
          text: "Hello!",
          to: "#testchannel",
        }),
      ).rejects.toThrow("Twitch account not found: nonexistent");
    });

    it("should throw when no channel specified", async () => {
      const accountWithoutChannel = { ...mockAccount, channel: undefined as unknown as string };
      setupAccountContext({ account: accountWithoutChannel });

      await expect(
        twitchOutbound.sendText!({
          accountId: "default",
          cfg: mockConfig,
          text: "Hello!",
          to: "",
        }),
      ).rejects.toThrow("No channel specified");
    });

    it("should use account channel when target not provided", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "msg-456",
        ok: true,
      });

      await twitchOutbound.sendText!({
        accountId: "default",
        cfg: mockConfig,
        text: "Hello!",
        to: "",
      });

      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        "testchannel",
        "Hello!",
        mockConfig,
        "default",
        true,
        console,
      );
    });

    it("uses configured defaultAccount when accountId is omitted", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      vi.mocked(resolveTwitchAccountContext)
        .mockImplementationOnce(() => ({
          account: {
            ...mockAccount,
            channel: "secondary-channel",
          },
          accountId: "secondary",
          availableAccountIds: ["default", "secondary"],
          configured: true,
          tokenResolution: { source: "config", token: mockAccount.accessToken },
        }))
        .mockImplementation((_cfg, accountId) => ({
          account: {
            ...mockAccount,
            channel: "secondary-channel",
          },
          accountId: accountId?.trim() || "secondary",
          availableAccountIds: ["default", "secondary"],
          configured: true,
          tokenResolution: { source: "config", token: mockAccount.accessToken },
        }));
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "msg-secondary",
        ok: true,
      });

      await twitchOutbound.sendText!({
        cfg: {
          channels: {
            twitch: {
              defaultAccount: "secondary",
            },
          },
        } as typeof mockConfig,
        text: "Hello!",
        to: "#secondary-channel",
      });

      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        "secondary-channel",
        "Hello!",
        expect.any(Object),
        "secondary",
        true,
        console,
      );
    });

    it("should handle abort signal", async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        twitchOutbound.sendText!({
          accountId: "default",
          cfg: mockConfig,
          signal: abortController.signal,
          text: "Hello!",
          to: "#testchannel",
        } as Parameters<NonNullable<typeof twitchOutbound.sendText>>[0]),
      ).rejects.toThrow("Outbound delivery aborted");
    });

    it("should throw on send failure", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        error: "Connection lost",
        messageId: "failed-msg",
        ok: false,
      });

      await expect(
        twitchOutbound.sendText!({
          accountId: "default",
          cfg: mockConfig,
          text: "Hello!",
          to: "#testchannel",
        }),
      ).rejects.toThrow("Connection lost");
    });
  });

  describe("sendMedia", () => {
    it("should combine text and media URL", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "media-msg-123",
        ok: true,
      });

      const result = await twitchOutbound.sendMedia!({
        accountId: "default",
        cfg: mockConfig,
        mediaUrl: "https://example.com/image.png",
        text: "Check this:",
        to: "#testchannel",
      });

      expect(result.channel).toBe("twitch");
      expect(result.messageId).toBe("media-msg-123");
      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        expect.anything(),
        "Check this: https://example.com/image.png",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should send media URL only when no text", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "media-only-msg",
        ok: true,
      });

      await twitchOutbound.sendMedia!({
        accountId: "default",
        cfg: mockConfig,
        mediaUrl: "https://example.com/image.png",
        text: "",
        to: "#testchannel",
      });

      expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
        expect.anything(),
        "https://example.com/image.png",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should handle abort signal", async () => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        twitchOutbound.sendMedia!({
          accountId: "default",
          cfg: mockConfig,
          mediaUrl: "https://example.com/image.png",
          signal: abortController.signal,
          text: "Check this:",
          to: "#testchannel",
        } as Parameters<NonNullable<typeof twitchOutbound.sendMedia>>[0]),
      ).rejects.toThrow("Outbound delivery aborted");
    });
  });
});
