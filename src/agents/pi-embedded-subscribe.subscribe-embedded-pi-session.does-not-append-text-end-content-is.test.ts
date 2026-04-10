import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  function setupTextEndSubscription() {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitDelta = (delta: string) => {
      emitAssistantTextDelta({ delta, emit });
    };

    const emitTextEnd = (content: string) => {
      emitAssistantTextEnd({ content, emit });
    };

    return { emitDelta, emitTextEnd, onBlockReply, subscription };
  }

  it.each([
    {
      content: "Hello",
      delta: "Hello world",
      expected: "Hello world",
      name: "does not append when text_end content is a prefix of deltas",
    },
    {
      content: "world",
      delta: "Hello world",
      expected: "Hello world",
      name: "does not append when text_end content is already contained",
    },
    {
      content: "Hello world",
      delta: "Hello",
      expected: "Hello world",
      name: "appends suffix when text_end content extends deltas",
    },
  ])("$name", async ({ delta, content, expected }) => {
    const { onBlockReply, subscription, emitDelta, emitTextEnd } = setupTextEndSubscription();

    emitDelta(delta);
    emitTextEnd(content);
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual([expected]);
  });
});
