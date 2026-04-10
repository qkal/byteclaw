import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  expectFencedChunks,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("reopens fenced blocks when splitting inside them", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      chunking: {
        maxChars: 30,
        minChars: 10,
      },
      onBlockReply,
    });

    const text = `\`\`\`txt\n${"a".repeat(80)}\n\`\`\``;
    emitAssistantTextDeltaAndEnd({ emit, text });
    expectFencedChunks(onBlockReply.mock.calls, "```txt");
  });
  it("avoids splitting inside tilde fences", () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      chunking: {
        maxChars: 25,
        minChars: 5,
      },
      onBlockReply,
    });

    const text = "Intro\n\n~~~sh\nline1\nline2\n~~~\n\nOutro";
    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(3);
    expect(onBlockReply.mock.calls[1][0].text).toBe("~~~sh\nline1\nline2\n~~~");
  });
});
