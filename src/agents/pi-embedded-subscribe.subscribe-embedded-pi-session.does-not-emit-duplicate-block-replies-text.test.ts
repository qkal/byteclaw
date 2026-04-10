import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("does not emit duplicate block replies when text_end repeats", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ delta: "Hello block", emit });
    emitAssistantTextEnd({ emit });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });
  it("does not duplicate assistantTexts when message_end repeats", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      runId: "run",
      session,
    });

    const assistantMessage = {
      content: [{ text: "Hello world", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessage, type: "message_end" });
    emit({ message: assistantMessage, type: "message_end" });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("does not duplicate assistantTexts when message_end repeats with trailing whitespace changes", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      runId: "run",
      session,
    });

    const assistantMessageWithNewline = {
      content: [{ text: "Hello world\n", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    const assistantMessageTrimmed = {
      content: [{ text: "Hello world", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessageWithNewline, type: "message_end" });
    emit({ message: assistantMessageTrimmed, type: "message_end" });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("does not duplicate assistantTexts when message_end repeats with reasoning blocks", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      reasoningMode: "on",
      runId: "run",
      session,
    });

    const assistantMessage = {
      content: [
        { thinking: "Because", type: "thinking" },
        { text: "Hello world", type: "text" },
      ],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessage, type: "message_end" });
    emit({ message: assistantMessage, type: "message_end" });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("populates assistantTexts for non-streaming models with chunking enabled", () => {
    // Non-streaming models (e.g. zai/glm-4.7): no text_delta events; message_end
    // Must still populate assistantTexts so providers can deliver a final reply.
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      blockReplyChunking: { maxChars: 200, minChars: 50 },
      runId: "run",
      session, // Chunking enabled
    });

    // Simulate non-streaming model: only message_start and message_end, no text_delta
    emit({ message: { role: "assistant" }, type: "message_start" });

    const assistantMessage = {
      content: [{ text: "Response from non-streaming model", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessage, type: "message_end" });

    expect(subscription.assistantTexts).toEqual(["Response from non-streaming model"]);
  });
});
