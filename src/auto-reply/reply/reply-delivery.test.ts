import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import {
  createBlockReplyDeliveryHandler,
  normalizeReplyPayloadDirectives,
} from "./reply-delivery.js";
import type { TypingSignaler } from "./typing-mode.js";

type BlockReplyPipelineLike = NonNullable<
  Parameters<typeof createBlockReplyDeliveryHandler>[0]["blockReplyPipeline"]
>;

describe("createBlockReplyDeliveryHandler", () => {
  it("sends media-bearing block replies even when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});
    const normalizeStreamingText = vi.fn((payload: { text?: string }) => ({
      skip: false,
      text: payload.text,
    }));
    const directlySentBlockKeys = new Set<string>();
    const typingSignals = {
      signalTextDelta: vi.fn(async () => {}),
    } as unknown as TypingSignaler;

    const handler = createBlockReplyDeliveryHandler({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      directlySentBlockKeys,
      normalizeStreamingText,
      onBlockReply,
      typingSignals,
    });

    await handler({
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
      text: "here's the vibe",
    });

    expect(onBlockReply).toHaveBeenCalledWith({
      audioAsVoice: false,
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
      replyToCurrent: true,
      replyToId: undefined,
      replyToTag: undefined,
      text: undefined,
    });
    expect(directlySentBlockKeys).toEqual(
      new Set([
        createBlockReplyContentKey({
          mediaUrls: ["/tmp/generated.png"],
          replyToCurrent: true,
          text: "here's the vibe",
        }),
      ]),
    );
    expect(typingSignals.signalTextDelta).toHaveBeenCalledWith("here's the vibe");
  });

  it("keeps text-only block replies buffered when block streaming is disabled", async () => {
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      directlySentBlockKeys: new Set(),
      normalizeStreamingText: (payload) => ({ skip: false, text: payload.text }),
      onBlockReply,
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
    });

    await handler({ text: "text only" });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("trims leading whitespace in block-streamed replies", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;

    const handler = createBlockReplyDeliveryHandler({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline,
      blockStreamingEnabled: true,
      directlySentBlockKeys: new Set(),
      normalizeStreamingText: (payload) => ({ skip: false, text: payload.text }),
      onBlockReply: vi.fn(async () => {}),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
    });

    await handler({ text: "\n\n  Hello from stream" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      audioAsVoice: false,
      mediaUrl: undefined,
      mediaUrls: undefined,
      replyToCurrent: undefined,
      replyToId: undefined,
      replyToTag: undefined,
      text: "Hello from stream",
    });
  });

  it("parses media directives in block replies before path normalization", () => {
    const normalized = normalizeReplyPayloadDirectives({
      parseMode: "auto",
      payload: { text: "Result\nMEDIA: ./image.png" },
      trimLeadingWhitespace: true,
    });

    expect(normalized.payload).toMatchObject({
      mediaUrl: "./image.png",
      mediaUrls: ["./image.png"],
      text: "Result",
    });
  });

  it("passes normalized media block replies through media path normalization", async () => {
    const blockReplyPipeline = {
      enqueue: vi.fn(),
    } as unknown as BlockReplyPipelineLike;
    const absPath = path.join("/tmp/home", "openclaw", "image.png");

    const handler = createBlockReplyDeliveryHandler({
      applyReplyToMode: (payload) => payload,
      blockReplyPipeline,
      blockStreamingEnabled: true,
      directlySentBlockKeys: new Set(),
      normalizeMediaPaths: async (payload) => ({
        ...payload,
        mediaUrl: absPath,
        mediaUrls: [absPath],
      }),
      normalizeStreamingText: (payload) => ({ skip: false, text: payload.text }),
      onBlockReply: vi.fn(async () => {}),
      typingSignals: {
        signalTextDelta: vi.fn(async () => {}),
      } as unknown as TypingSignaler,
    });

    await handler({ text: "Result\nMEDIA: ./image.png" });

    expect(blockReplyPipeline.enqueue).toHaveBeenCalledWith({
      audioAsVoice: false,
      mediaUrl: absPath,
      mediaUrls: [absPath],
      replyToCurrent: false,
      replyToId: undefined,
      replyToTag: false,
      text: "Result",
    });
  });
});
