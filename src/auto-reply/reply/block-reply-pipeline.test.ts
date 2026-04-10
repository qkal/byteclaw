import { describe, expect, it } from "vitest";
import {
  createBlockReplyContentKey,
  createBlockReplyPayloadKey,
  createBlockReplyPipeline,
} from "./block-reply-pipeline.js";

describe("createBlockReplyPayloadKey", () => {
  it("produces different keys for payloads differing only by replyToId", () => {
    const a = createBlockReplyPayloadKey({ replyToId: "post-1", text: "hello world" });
    const b = createBlockReplyPayloadKey({ replyToId: "post-2", text: "hello world" });
    const c = createBlockReplyPayloadKey({ text: "hello world" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("produces different keys for payloads with different text", () => {
    const a = createBlockReplyPayloadKey({ text: "hello" });
    const b = createBlockReplyPayloadKey({ text: "world" });
    expect(a).not.toBe(b);
  });

  it("produces different keys for payloads with different media", () => {
    const a = createBlockReplyPayloadKey({ mediaUrl: "file:///a.png", text: "hello" });
    const b = createBlockReplyPayloadKey({ mediaUrl: "file:///b.png", text: "hello" });
    expect(a).not.toBe(b);
  });

  it("trims whitespace from text for key comparison", () => {
    const a = createBlockReplyPayloadKey({ text: "  hello  " });
    const b = createBlockReplyPayloadKey({ text: "hello" });
    expect(a).toBe(b);
  });
});

describe("createBlockReplyContentKey", () => {
  it("produces the same key for payloads differing only by replyToId", () => {
    const a = createBlockReplyContentKey({ replyToId: "post-1", text: "hello world" });
    const b = createBlockReplyContentKey({ replyToId: "post-2", text: "hello world" });
    const c = createBlockReplyContentKey({ text: "hello world" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps separate deliveries for same text with different replyToId", async () => {
    const sent: { text?: string; replyToId?: string }[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ replyToId: payload.replyToId, text: payload.text });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ replyToId: "thread-root-1", text: "response text" });
    pipeline.enqueue({ replyToId: undefined, text: "response text" });
    await pipeline.flush();

    expect(sent).toEqual([
      { replyToId: "thread-root-1", text: "response text" },
      { replyToId: undefined, text: "response text" },
    ]);
  });

  it("hasSentPayload matches regardless of replyToId", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ replyToId: "thread-root-1", text: "response text" });
    await pipeline.flush();

    // Final payload with no replyToId should be recognized as already sent
    expect(pipeline.hasSentPayload({ text: "response text" })).toBe(true);
    expect(pipeline.hasSentPayload({ replyToId: "other-id", text: "response text" })).toBe(true);
  });
});
