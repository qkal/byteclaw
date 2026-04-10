import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession reply tags", () => {
  function createBlockReplyHarness() {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        breakPreference: "newline",
        maxChars: 50,
        minChars: 1,
      },
      onBlockReply,
      runId: "run",
      session,
    });

    return { emit, onBlockReply };
  }

  it("carries reply_to_current across tag-only block chunks", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "[[reply_to_current]]\nHello", emit });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      content: [{ text: "[[reply_to_current]]\nHello", type: "text" }],
      role: "assistant",
    } as AssistantMessage;
    emit({ message: assistantMessage, type: "message_end" });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const payload = onBlockReply.mock.calls[0]?.[0];
    expect(payload?.text).toBe("Hello");
    expect(payload?.replyToCurrent).toBe(true);
    expect(payload?.replyToTag).toBe(true);
  });

  it("flushes trailing directive tails on stream end", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "Hello [[", emit });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      content: [{ text: "Hello [[", type: "text" }],
      role: "assistant",
    } as AssistantMessage;
    emit({ message: assistantMessage, type: "message_end" });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Hello");
    expect(onBlockReply.mock.calls[1]?.[0]?.text).toBe("[[");
  });

  it("streams partial replies past reply_to tags split across chunks", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      onPartialReply,
      runId: "run",
      session,
    });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "[[reply_to:1897", emit });
    emitAssistantTextDelta({ delta: "]] Hello", emit });
    emitAssistantTextDelta({ delta: " world", emit });
    emitAssistantTextEnd({ emit });

    const lastPayload = onPartialReply.mock.calls.at(-1)?.[0];
    expect(lastPayload?.text).toBe("Hello world");
    for (const call of onPartialReply.mock.calls) {
      expect(call[0]?.text?.includes("[[reply_to")).toBe(false);
    }
  });
});
