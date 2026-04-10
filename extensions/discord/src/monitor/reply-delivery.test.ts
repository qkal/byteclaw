import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThreadBindingManager,
  __testing as threadBindingTesting,
} from "./thread-bindings.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendWebhookMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendDiscordTextMock = vi.hoisted(() => vi.fn());
const retryAsyncMock = vi.hoisted(() =>
  vi.fn(
    async (
      fn: () => Promise<unknown>,
      opts?: {
        attempts?: number;
        shouldRetry?: (err: unknown) => boolean;
      },
    ) => {
      const attempts = Math.max(1, opts?.attempts ?? 1);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;
          if (attempt >= attempts || opts?.shouldRetry?.(error) === false) {
            throw error;
          }
        }
      }
      throw lastError;
    },
  ),
);

vi.mock("../send.js", async () => {
  const actual = await vi.importActual<typeof import("../send.js")>("../send.js");
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
    sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
    sendWebhookMessageDiscord: (...args: unknown[]) => sendWebhookMessageDiscordMock(...args),
  };
});

vi.mock("../send.shared.js", () => ({
  sendDiscordText: (...args: unknown[]) => sendDiscordTextMock(...args),
}));

vi.mock("openclaw/plugin-sdk/retry-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/retry-runtime")>(
    "openclaw/plugin-sdk/retry-runtime",
  );
  return {
    ...actual,
    retryAsync: retryAsyncMock,
  };
});

let deliverDiscordReply: typeof import("./reply-delivery.js").deliverDiscordReply;

describe("deliverDiscordReply", () => {
  const runtime = {} as RuntimeEnv;
  const cfg = {
    channels: { discord: { token: "test-token" } },
  } as OpenClawConfig;
  const expectBotSendRetrySuccess = async (status: number, message: string) => {
    sendMessageDiscordMock
      .mockRejectedValueOnce(Object.assign(new Error(message), { status }))
      .mockResolvedValueOnce({ channelId: "channel-1", messageId: "msg-1" });

    await deliverDiscordReply({
      cfg,
      replies: [{ text: "retry me" }],
      runtime,
      target: "channel:123",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
  };
  const createBoundThreadBindings = async (
    overrides: Partial<{
      threadId: string;
      channelId: string;
      targetSessionKey: string;
      agentId: string;
      label: string;
      webhookId: string;
      webhookToken: string;
      introText: string;
    }> = {},
  ) => {
    const threadBindings = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      persist: false,
    });
    await threadBindings.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      introText: "",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      threadId: "thread-1",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      ...overrides,
    });
    return threadBindings;
  };

  beforeAll(async () => {
    ({ deliverDiscordReply } = await import("./reply-delivery.js"));
  });

  beforeEach(() => {
    sendMessageDiscordMock.mockClear().mockResolvedValue({
      channelId: "channel-1",
      messageId: "msg-1",
    });
    sendVoiceMessageDiscordMock.mockClear().mockResolvedValue({
      channelId: "channel-1",
      messageId: "voice-1",
    });
    sendWebhookMessageDiscordMock.mockClear().mockResolvedValue({
      channelId: "thread-1",
      messageId: "webhook-1",
    });
    sendDiscordTextMock.mockClear().mockResolvedValue({
      channel_id: "channel-1",
      id: "msg-direct-1",
    });
    retryAsyncMock.mockClear();
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("routes audioAsVoice payloads through the voice API and sends text separately", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [
        {
          audioAsVoice: true,
          mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.mp3"],
          text: "Hello there",
        },
      ],
      replyToId: "reply-1",
      runtime,
      target: "channel:123",
      textLimit: 2000,
      token: "token",
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "https://example.com/voice.ogg",
      expect.objectContaining({ replyTo: "reply-1", token: "token" }),
    );

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:123",
      "Hello there",
      expect.objectContaining({ replyTo: "reply-1", token: "token" }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:123",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/extra.mp3",
        replyTo: "reply-1",
        token: "token",
      }),
    );
  });

  it("skips follow-up text when the voice payload text is blank", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [
        {
          audioAsVoice: true,
          mediaUrl: "https://example.com/voice.ogg",
          text: "   ",
        },
      ],
      runtime,
      target: "channel:456",
      textLimit: 2000,
      token: "token",
    });

    expect(sendVoiceMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("passes mediaLocalRoots through media sends", async () => {
    const mediaLocalRoots = ["/tmp/workspace-agent"] as const;
    await deliverDiscordReply({
      cfg,
      mediaLocalRoots,
      replies: [
        {
          mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
          text: "Media reply",
        },
      ],
      runtime,
      target: "channel:654",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:654",
      "Media reply",
      expect.objectContaining({
        mediaLocalRoots,
        mediaUrl: "https://example.com/first.png",
        token: "token",
      }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:654",
      "",
      expect.objectContaining({
        mediaLocalRoots,
        mediaUrl: "https://example.com/second.png",
        token: "token",
      }),
    );
  });

  it("sends text first and videos as a separate media-only follow-up", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [
        {
          mediaUrls: ["/tmp/molty.mp4"],
          text: "done — i kicked off a 5s Molty clip",
        },
      ],
      replyToId: "reply-1",
      runtime,
      target: "channel:654",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      1,
      "channel:654",
      "done — i kicked off a 5s Molty clip",
      expect.objectContaining({
        replyTo: "reply-1",
        token: "token",
      }),
    );
    expect(sendMessageDiscordMock).toHaveBeenNthCalledWith(
      2,
      "channel:654",
      "",
      expect.objectContaining({
        mediaUrl: "/tmp/molty.mp4",
        replyTo: "reply-1",
        token: "token",
      }),
    );
  });

  it("forwards cfg to Discord send helpers", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [{ text: "cfg path" }],
      runtime,
      target: "channel:101",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:101",
      "cfg path",
      expect.objectContaining({ cfg }),
    );
  });

  it("honors payload reply targets even when replyToMode is off", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [
        {
          replyToCurrent: true,
          replyToId: "reply-explicit-1",
          replyToTag: true,
          text: "explicit reply",
        },
      ],
      replyToMode: "off",
      runtime,
      target: "channel:202",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:202",
      "explicit reply",
      expect.objectContaining({ replyTo: "reply-explicit-1" }),
    );
  });

  it("uses replyToId only for the first chunk when replyToMode is first", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [
        {
          text: "1234567890",
        },
      ],
      replyToId: "reply-1",
      replyToMode: "first",
      runtime,
      target: "channel:789",
      textLimit: 5,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock.mock.calls).toEqual([
      expect.arrayContaining([
        "channel:789",
        "12345",
        expect.objectContaining({ replyTo: "reply-1" }),
      ]),
      expect.arrayContaining([
        "channel:789",
        "67890",
        expect.not.objectContaining({ replyTo: expect.anything() }),
      ]),
    ]);
  });

  it("uses replyToId only for the first chunk when replyToMode is batched", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [
        {
          text: "1234567890",
        },
      ],
      replyToId: "reply-1",
      replyToMode: "batched",
      runtime,
      target: "channel:789",
      textLimit: 5,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(sendMessageDiscordMock.mock.calls).toEqual([
      expect.arrayContaining([
        "channel:789",
        "12345",
        expect.objectContaining({ replyTo: "reply-1" }),
      ]),
      expect.arrayContaining([
        "channel:789",
        "67890",
        expect.not.objectContaining({ replyTo: expect.anything() }),
      ]),
    ]);
  });

  it("does not consume replyToId for replyToMode=first on whitespace-only payloads", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [{ text: "   " }, { text: "actual reply" }],
      replyToId: "reply-1",
      replyToMode: "first",
      runtime,
      target: "channel:789",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:789",
      "actual reply",
      expect.objectContaining({ replyTo: "reply-1", token: "token" }),
    );
  });

  it("preserves leading whitespace in delivered text chunks", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [{ text: "  leading text" }],
      runtime,
      target: "channel:789",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:789",
      "  leading text",
      expect.objectContaining({ token: "token" }),
    );
  });

  it("sends text chunks in order via sendDiscordText when rest is provided", async () => {
    const fakeRest = {} as import("@buape/carbon").RequestClient;
    const callOrder: string[] = [];
    sendDiscordTextMock.mockImplementation(
      async (_rest: unknown, _channelId: unknown, text: string) => {
        callOrder.push(text);
        return { channel_id: "789", id: `msg-${callOrder.length}` };
      },
    );

    await deliverDiscordReply({
      cfg,
      replies: [{ text: "1234567890" }],
      rest: fakeRest,
      runtime,
      target: "channel:789",
      textLimit: 5,
      token: "token",
    });

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendDiscordTextMock).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["12345", "67890"]);
    expect(sendDiscordTextMock.mock.calls[0]?.[1]).toBe("789");
    expect(sendDiscordTextMock.mock.calls[1]?.[1]).toBe("789");
  });

  it("passes maxLinesPerMessage and chunkMode through the fast path", async () => {
    const fakeRest = {} as import("@buape/carbon").RequestClient;

    await deliverDiscordReply({
      cfg,
      chunkMode: "newline",
      maxLinesPerMessage: 120,
      replies: [{ text: Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n") }],
      rest: fakeRest,
      runtime,
      target: "channel:789",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendDiscordTextMock).toHaveBeenCalledTimes(1);
    const firstSendDiscordTextCall = sendDiscordTextMock.mock.calls[0];
    const [, , , , , maxLinesPerMessageArg, , , chunkModeArg] = firstSendDiscordTextCall ?? [];

    expect(maxLinesPerMessageArg).toBe(120);
    expect(chunkModeArg).toBe("newline");
  });

  it("falls back to sendMessageDiscord when rest is not provided", async () => {
    await deliverDiscordReply({
      cfg,
      replies: [{ text: "single chunk" }],
      runtime,
      target: "channel:789",
      textLimit: 2000,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendDiscordTextMock).not.toHaveBeenCalled();
  });

  it("retries bot send on 429 rate limit then succeeds", async () => {
    await expectBotSendRetrySuccess(429, "rate limited");
  });

  it("retries bot send on 500 server error then succeeds", async () => {
    await expectBotSendRetrySuccess(500, "internal");
  });

  it("does not retry on 4xx client errors", async () => {
    const clientErr = Object.assign(new Error("bad request"), { status: 400 });
    sendMessageDiscordMock.mockRejectedValueOnce(clientErr);

    await expect(
      deliverDiscordReply({
        cfg,
        replies: [{ text: "fail" }],
        runtime,
        target: "channel:123",
        textLimit: 2000,
        token: "token",
      }),
    ).rejects.toThrow("bad request");

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retry attempts", async () => {
    const rateLimitErr = Object.assign(new Error("rate limited"), { status: 429 });
    sendMessageDiscordMock.mockRejectedValue(rateLimitErr);

    await expect(
      deliverDiscordReply({
        cfg,
        replies: [{ text: "persistent failure" }],
        runtime,
        target: "channel:123",
        textLimit: 2000,
        token: "token",
      }),
    ).rejects.toThrow("rate limited");

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(3);
  });

  it("delivers remaining chunks after a mid-sequence retry", async () => {
    sendMessageDiscordMock
      .mockResolvedValueOnce({ messageId: "c1" })
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce({ messageId: "c2-retry" })
      .mockResolvedValueOnce({ messageId: "c3" });

    await deliverDiscordReply({
      cfg,
      replies: [{ text: "A".repeat(6) }],
      runtime,
      target: "channel:123",
      textLimit: 2,
      token: "token",
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(4);
  });

  it("sends bound-session text replies through webhook delivery", async () => {
    const threadBindings = await createBoundThreadBindings({ label: "codex-refactor" });

    await deliverDiscordReply({
      cfg,
      replies: [{ text: "Hello from subagent" }],
      replyToId: "reply-1",
      runtime,
      sessionKey: "agent:main:subagent:child",
      target: "channel:thread-1",
      textLimit: 2000,
      threadBindings,
      token: "token",
    });

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledWith(
      "Hello from subagent",
      expect.objectContaining({
        accountId: "default",
        cfg,
        replyTo: "reply-1",
        threadId: "thread-1",
        webhookId: "wh_1",
        webhookToken: "tok_1",
      }),
    );
    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("touches bound-thread activity after outbound delivery", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const threadBindings = await createBoundThreadBindings();
      vi.setSystemTime(new Date("2026-02-20T00:02:00.000Z"));

      await deliverDiscordReply({
        cfg,
        replies: [{ text: "Activity ping" }],
        runtime,
        sessionKey: "agent:main:subagent:child",
        target: "channel:thread-1",
        textLimit: 2000,
        threadBindings,
        token: "token",
      });

      expect(threadBindings.getByThreadId("thread-1")?.lastActivityAt).toBe(
        new Date("2026-02-20T00:02:00.000Z").getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to bot send when webhook delivery fails", async () => {
    const threadBindings = await createBoundThreadBindings();
    sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    await deliverDiscordReply({
      accountId: "default",
      cfg,
      replies: [{ text: "Fallback path" }],
      runtime,
      sessionKey: "agent:main:subagent:child",
      target: "channel:thread-1",
      textLimit: 2000,
      threadBindings,
      token: "token",
    });

    expect(sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageDiscordMock.mock.calls[0]?.[1]?.cfg).toBe(cfg);
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      "Fallback path",
      expect.objectContaining({ accountId: "default", token: "token" }),
    );
  });

  it("does not use thread webhook when outbound target is not a bound thread", async () => {
    const threadBindings = await createBoundThreadBindings();

    await deliverDiscordReply({
      accountId: "default",
      cfg,
      replies: [{ text: "Parent channel delivery" }],
      runtime,
      sessionKey: "agent:main:subagent:child",
      target: "channel:parent-1",
      textLimit: 2000,
      threadBindings,
      token: "token",
    });

    expect(sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expect(sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:parent-1",
      "Parent channel delivery",
      expect.objectContaining({ accountId: "default", token: "token" }),
    );
  });
});
