import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  expectDiscordThreadBotSend,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let normalizeDiscordOutboundTarget: typeof import("./normalize.js").normalizeDiscordOutboundTarget;
let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;

beforeAll(async () => {
  ({ normalizeDiscordOutboundTarget } = await import("./normalize.js"));
  ({ discordOutbound } = await import("./outbound-adapter.js"));
});

describe("normalizeDiscordOutboundTarget", () => {
  it("normalizes bare numeric IDs to channel: prefix", () => {
    expect(normalizeDiscordOutboundTarget("1470130713209602050")).toEqual({
      ok: true,
      to: "channel:1470130713209602050",
    });
  });

  it("passes through channel: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("channel:123")).toEqual({ ok: true, to: "channel:123" });
  });

  it("passes through user: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("user:123")).toEqual({ ok: true, to: "user:123" });
  });

  it("passes through channel name strings", () => {
    expect(normalizeDiscordOutboundTarget("general")).toEqual({ ok: true, to: "general" });
  });

  it("returns error for empty target", () => {
    expect(normalizeDiscordOutboundTarget("").ok).toBe(false);
  });

  it("returns error for undefined target", () => {
    expect(normalizeDiscordOutboundTarget(undefined).ok).toBe(false);
  });

  it("trims whitespace", () => {
    expect(normalizeDiscordOutboundTarget("  123  ")).toEqual({ ok: true, to: "channel:123" });
  });
});

describe("discordOutbound", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
  });

  it("routes text sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendText?.({
      accountId: "default",
      cfg: {},
      text: "hello",
      threadId: "thread-1",
      to: "channel:parent-1",
    });

    expectDiscordThreadBotSend({
      hoisted,
      result,
      text: "hello",
    });
  });

  it("uses webhook persona delivery for bound thread text replies", async () => {
    mockDiscordBoundThreadManager(hoisted);
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };

    const result = await discordOutbound.sendText?.({
      accountId: "default",
      cfg,
      identity: {
        avatarUrl: "https://example.com/avatar.png",
        name: "Codex",
      },
      replyToId: "reply-1",
      text: "hello from persona",
      threadId: "thread-1",
      to: "channel:parent-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledWith(
      "hello from persona",
      expect.objectContaining({
        accountId: "default",
        avatarUrl: "https://example.com/avatar.png",
        replyTo: "reply-1",
        threadId: "thread-1",
        username: "Codex",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      }),
    );
    expect(
      (hoisted.sendWebhookMessageDiscordMock.mock.calls[0]?.[1] as { cfg?: unknown } | undefined)
        ?.cfg,
    ).toBe(cfg);
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      channelId: "thread-1",
      messageId: "msg-webhook-1",
    });
  });

  it("falls back to bot send for silent delivery on bound threads", async () => {
    mockDiscordBoundThreadManager(hoisted);

    const result = await discordOutbound.sendText?.({
      accountId: "default",
      cfg: {},
      silent: true,
      text: "silent update",
      threadId: "thread-1",
      to: "channel:parent-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expectDiscordThreadBotSend({
      hoisted,
      options: { silent: true },
      result,
      text: "silent update",
    });
  });

  it("falls back to bot send when webhook send fails", async () => {
    mockDiscordBoundThreadManager(hoisted);
    hoisted.sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    const result = await discordOutbound.sendText?.({
      accountId: "default",
      cfg: {},
      text: "fallback",
      threadId: "thread-1",
      to: "channel:parent-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expectDiscordThreadBotSend({
      hoisted,
      result,
      text: "fallback",
    });
  });

  it("routes poll sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendPoll?.({
      accountId: "default",
      cfg: {},
      poll: {
        options: ["banana", "apple"],
        question: "Best snack?",
      },
      threadId: "thread-1",
      to: "channel:parent-1",
    });

    expect(hoisted.sendPollDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      {
        options: ["banana", "apple"],
        question: "Best snack?",
      },
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      channelId: "ch-1",
      messageId: "poll-1",
    });
  });

  it("sends component payload media sequences with the component message first", async () => {
    hoisted.sendDiscordComponentMessageMock.mockResolvedValueOnce({
      channelId: "ch-1",
      messageId: "component-1",
    });
    hoisted.sendMessageDiscordMock.mockResolvedValueOnce({
      channelId: "ch-1",
      messageId: "msg-2",
    });

    const result = await discordOutbound.sendPayload?.({
      accountId: "default",
      cfg: {},
      mediaLocalRoots: ["/tmp/media"],
      payload: {
        channelData: {
          discord: {
            components: { components: [], text: "hello" },
          },
        },
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        text: "hello",
      },
      text: "",
      to: "channel:123456",
    });

    expect(hoisted.sendDiscordComponentMessageMock).toHaveBeenCalledWith(
      "channel:123456",
      expect.objectContaining({ text: "hello" }),
      expect.objectContaining({
        accountId: "default",
        mediaLocalRoots: ["/tmp/media"],
        mediaUrl: "https://example.com/1.png",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "",
      expect.objectContaining({
        accountId: "default",
        mediaLocalRoots: ["/tmp/media"],
        mediaUrl: "https://example.com/2.png",
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      channelId: "ch-1",
      messageId: "msg-2",
    });
  });

  it("neutralizes approval mentions only for approval payloads", async () => {
    await discordOutbound.sendPayload?.({
      accountId: "default",
      cfg: {},
      payload: {
        channelData: {
          execApproval: {
            approvalId: "req-1",
            approvalSlug: "req-1",
          },
        },
        text: "Approval @everyone <@123> <#456>",
      },
      text: "",
      to: "channel:123456",
    });

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "Approval @\u200beveryone <@\u200b123> <#\u200b456>",
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("leaves non-approval mentions unchanged", async () => {
    await discordOutbound.sendPayload?.({
      accountId: "default",
      cfg: {},
      payload: {
        text: "Hello @everyone",
      },
      text: "",
      to: "channel:123456",
    });

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "Hello @everyone",
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });
});
