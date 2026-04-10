import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("does not duplicate when text_end repeats full content", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ delta: "Good morning!", emit });
    emitAssistantTextEnd({ content: "Good morning!", emit });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual(["Good morning!"]);
  });
  it("does not duplicate block chunks when text_end repeats full content", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({
      blockReplyChunking: {
        breakPreference: "newline",
        maxChars: 40,
        minChars: 5,
      },
      onBlockReply,
    });

    const fullText = "First line\nSecond line\nThird line\n";

    emitAssistantTextDelta({ delta: fullText, emit });
    await Promise.resolve();

    const callsAfterDelta = onBlockReply.mock.calls.length;
    expect(callsAfterDelta).toBeGreaterThan(0);

    emitAssistantTextEnd({ content: fullText, emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(callsAfterDelta);
  });
});
