import { describe, expect, it, vi } from "vitest";
import {
  countOutboundMedia,
  deliverFormattedTextWithAttachments,
  deliverTextOrMediaReply,
  hasOutboundMedia,
  hasOutboundReplyContent,
  hasOutboundText,
  isNumericTargetId,
  resolveOutboundMediaUrls,
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";

describe("sendPayloadWithChunkedTextAndMedia", () => {
  it("returns empty result when payload has no text and no media", async () => {
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: { payload: {} },
      emptyResult: { channel: "test", messageId: "" },
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      sendText: async () => ({ channel: "test", messageId: "text" }),
    });
    expect(result).toEqual({ channel: "test", messageId: "" });
  });

  it("sends first media with text and remaining media without text", async () => {
    const calls: { text: string; mediaUrl: string }[] = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      ctx: {
        payload: { mediaUrls: ["https://a", "https://b"], text: "hello" },
      },
      emptyResult: { channel: "test", messageId: "" },
      sendMedia: async (ctx) => {
        calls.push({ mediaUrl: ctx.mediaUrl, text: ctx.text });
        return { channel: "test", messageId: ctx.mediaUrl };
      },
      sendText: async () => ({ channel: "test", messageId: "text" }),
    });
    expect(calls).toEqual([
      { mediaUrl: "https://a", text: "hello" },
      { mediaUrl: "https://b", text: "" },
    ]);
    expect(result).toEqual({ channel: "test", messageId: "https://b" });
  });

  it("chunks text and sends each chunk", async () => {
    const chunks: string[] = [];
    const result = await sendPayloadWithChunkedTextAndMedia({
      chunker: () => ["alpha", "beta", "gamma"],
      ctx: { payload: { text: "alpha beta gamma" } },
      emptyResult: { channel: "test", messageId: "" },
      sendMedia: async () => ({ channel: "test", messageId: "media" }),
      sendText: async (ctx) => {
        chunks.push(ctx.text);
        return { channel: "test", messageId: ctx.text };
      },
      textChunkLimit: 5,
    });
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
    expect(result).toEqual({ channel: "test", messageId: "gamma" });
  });

  it("detects numeric target IDs", () => {
    expect(isNumericTargetId("12345")).toBe(true);
    expect(isNumericTargetId("  987  ")).toBe(true);
    expect(isNumericTargetId("ab12")).toBe(false);
    expect(isNumericTargetId("")).toBe(false);
  });
});

describe("resolveOutboundMediaUrls", () => {
  it.each([
    {
      expected: ["https://example.com/a.png", "https://example.com/b.png"],
      name: "prefers mediaUrls over the legacy single-media field",
      payload: {
        mediaUrl: "https://example.com/legacy.png",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    },
    {
      expected: ["https://example.com/legacy.png"],
      name: "falls back to the legacy single-media field",
      payload: {
        mediaUrl: "https://example.com/legacy.png",
      },
    },
  ])("$name", ({ payload, expected }) => {
    expect(resolveOutboundMediaUrls(payload)).toEqual(expected);
  });
});

describe("countOutboundMedia", () => {
  it.each([
    {
      expected: 2,
      name: "counts normalized media entries",
      payload: {
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    },
    {
      expected: 1,
      name: "counts legacy single-media payloads",
      payload: {
        mediaUrl: "https://example.com/legacy.png",
      },
    },
  ])("$name", ({ payload, expected }) => {
    expect(countOutboundMedia(payload)).toBe(expected);
  });
});

describe("hasOutboundMedia", () => {
  it("reports whether normalized payloads include media", () => {
    expect(hasOutboundMedia({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasOutboundMedia({ mediaUrl: "https://example.com/legacy.png" })).toBe(true);
    expect(hasOutboundMedia({})).toBe(false);
  });
});

describe("hasOutboundText", () => {
  it.each([
    {
      expected: true,
      name: "checks raw text presence by default",
      options: undefined,
      payload: { text: "hello" },
    },
    {
      expected: true,
      name: "treats whitespace-only text as present by default",
      options: undefined,
      payload: { text: "   " },
    },
    {
      expected: false,
      name: "returns false when text is missing",
      options: undefined,
      payload: {},
    },
    {
      expected: false,
      name: "can trim whitespace-only text",
      options: { trim: true },
      payload: { text: "   " },
    },
    {
      expected: true,
      name: "keeps non-empty trimmed text",
      options: { trim: true },
      payload: { text: " hi " },
    },
  ])("$name", ({ payload, options, expected }) => {
    expect(hasOutboundText(payload, options)).toBe(expected);
  });
});

describe("hasOutboundReplyContent", () => {
  it.each([
    {
      expected: true,
      name: "detects text content",
      options: undefined,
      payload: { text: "hello" },
    },
    {
      expected: true,
      name: "detects media content",
      options: undefined,
      payload: { mediaUrl: "https://example.com/a.png" },
    },
    {
      expected: false,
      name: "returns false when text and media are both missing",
      options: undefined,
      payload: {},
    },
    {
      expected: false,
      name: "can ignore whitespace-only text",
      options: { trimText: true },
      payload: { text: "   " },
    },
    {
      expected: true,
      name: "still reports content when trimmed text is blank but media exists",
      options: { trimText: true },
      payload: { mediaUrls: ["https://example.com/a.png"], text: "   " },
    },
  ])("$name", ({ payload, options, expected }) => {
    expect(hasOutboundReplyContent(payload, options)).toBe(expected);
  });
});

describe("resolveSendableOutboundReplyParts", () => {
  it("normalizes missing text and trims media urls", () => {
    expect(
      resolveSendableOutboundReplyParts({
        mediaUrls: [" https://example.com/a.png ", "   "],
      }),
    ).toEqual({
      hasContent: true,
      hasMedia: true,
      hasText: false,
      mediaCount: 1,
      mediaUrls: ["https://example.com/a.png"],
      text: "",
      trimmedText: "",
    });
  });

  it("accepts transformed text overrides", () => {
    expect(
      resolveSendableOutboundReplyParts(
        {
          text: "ignored",
        },
        {
          text: "  hello  ",
        },
      ),
    ).toEqual({
      hasContent: true,
      hasMedia: false,
      hasText: true,
      mediaCount: 0,
      mediaUrls: [],
      text: "  hello  ",
      trimmedText: "hello",
    });
  });
});

describe("resolveTextChunksWithFallback", () => {
  it.each([
    {
      chunks: ["a", "b"],
      expected: ["a", "b"],
      name: "returns existing chunks unchanged",
      text: "hello",
    },
    {
      chunks: [],
      expected: ["hello"],
      name: "falls back to the full text when chunkers return nothing",
      text: "hello",
    },
    {
      chunks: [],
      expected: [],
      name: "returns empty for empty text with no chunks",
      text: "",
    },
  ])("$name", ({ text, chunks, expected }) => {
    expect(resolveTextChunksWithFallback(text, chunks)).toEqual(expected);
  });
});

describe("deliverTextOrMediaReply", () => {
  it("sends media first with caption only on the first attachment", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { mediaUrls: ["https://a", "https://b"], text: "hello" },
        sendMedia,
        sendText,
        text: "hello",
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenNthCalledWith(1, {
      caption: "hello",
      mediaUrl: "https://a",
    });
    expect(sendMedia).toHaveBeenNthCalledWith(2, {
      caption: undefined,
      mediaUrl: "https://b",
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falls back to chunked text delivery when there is no media", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        chunkText: () => ["alpha", "beta", "gamma"],
        payload: { text: "alpha beta gamma" },
        sendMedia,
        sendText,
        text: "alpha beta gamma",
      }),
    ).resolves.toBe("text");

    expect(sendText).toHaveBeenCalledTimes(3);
    expect(sendText).toHaveBeenNthCalledWith(1, "alpha");
    expect(sendText).toHaveBeenNthCalledWith(2, "beta");
    expect(sendText).toHaveBeenNthCalledWith(3, "gamma");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("returns empty when chunking produces no sendable text", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        chunkText: () => [],
        payload: { text: "   " },
        sendMedia,
        sendText,
        text: "   ",
      }),
    ).resolves.toBe("empty");

    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("ignores blank media urls before sending", async () => {
    const sendMedia = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    await expect(
      deliverTextOrMediaReply({
        payload: { mediaUrls: ["   ", " https://a "], text: "hello" },
        sendMedia,
        sendText,
        text: "hello",
      }),
    ).resolves.toBe("media");

    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledWith({
      caption: "hello",
      mediaUrl: "https://a",
    });
  });
});

describe("sendMediaWithLeadingCaption", () => {
  it("passes leading-caption metadata to async error handlers", async () => {
    const send = vi
      .fn<({ mediaUrl, caption }: { mediaUrl: string; caption?: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn(async () => undefined);

    await expect(
      sendMediaWithLeadingCaption({
        caption: "hello",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        onError,
        send,
      }),
    ).resolves.toBe(true);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        caption: "hello",
        index: 0,
        isFirst: true,
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, {
      caption: undefined,
      mediaUrl: "https://example.com/b.png",
    });
  });
});

describe("deliverFormattedTextWithAttachments", () => {
  it("combines attachment links and forwards replyToId", async () => {
    const send = vi.fn(async () => undefined);

    await expect(
      deliverFormattedTextWithAttachments({
        payload: {
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          replyToId: "r1",
          text: "hello",
        },
        send,
      }),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith({
      replyToId: "r1",
      text: "hello\n\nAttachment: https://example.com/a.png\nAttachment: https://example.com/b.png",
    });
  });
});
