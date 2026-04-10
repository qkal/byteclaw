import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import {
  type OpenAiResponsesTextEventPhase,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
} from "./pi-embedded-subscribe.openai-responses.test-helpers.js";

type TextEndBlockReplyHarness = ReturnType<typeof createTextEndBlockReplyHarness>;

function emitOpenAiResponsesTextEvent(params: {
  emit: TextEndBlockReplyHarness["emit"];
  type: "text_delta" | "text_end";
  text: string;
  delta?: string;
  id: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
}) {
  const { emit, ...eventParams } = params;
  emit(createOpenAiResponsesTextEvent(eventParams));
}

function emitOpenAiResponsesTextDeltaAndEnd(params: {
  emit: TextEndBlockReplyHarness["emit"];
  text: string;
  delta?: string;
  id: string;
  phase?: OpenAiResponsesTextEventPhase;
}) {
  const { phase, ...eventParams } = params;
  emitOpenAiResponsesTextEvent({
    ...eventParams,
    partialPhase: phase,
    signaturePhase: phase,
    type: "text_delta",
  });
  emitOpenAiResponsesTextEvent({
    ...eventParams,
    delta: undefined,
    partialPhase: phase,
    signaturePhase: phase,
    type: "text_end",
  });
}

function emitOpenAiResponsesFinalMessageEnd(params: {
  emit: TextEndBlockReplyHarness["emit"];
  commentaryText: string;
  finalText: string;
}) {
  params.emit({
    message: {
      content: [
        createOpenAiResponsesTextBlock({
          text: params.commentaryText,
          id: "item_commentary",
          phase: "commentary",
        }),
        createOpenAiResponsesTextBlock({
          text: params.finalText,
          id: "item_final",
          phase: "final_answer",
        }),
      ],
      role: "assistant",
    } as AssistantMessage,
    type: "message_end",
  });
}

describe("subscribeEmbeddedPiSession", () => {
  it("emits block replies on text_end and does not duplicate on message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ delta: "Hello block", emit });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    const assistantMessage = {
      content: [{ text: "Hello block", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessage, type: "message_end" });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("does not duplicate when message_end flushes and a late text_end arrives", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ message: { role: "assistant" }, type: "message_start" });

    emitAssistantTextDelta({ delta: "Hello block", emit });

    const assistantMessage = {
      content: [{ text: "Hello block", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    // Simulate a provider that ends the message without emitting text_end.
    emit({ message: assistantMessage, type: "message_end" });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    // Some providers can still emit a late text_end; this must not re-emit.
    emitAssistantTextEnd({ content: "Hello block", emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("emits legacy structured partials on text_end without waiting for message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitOpenAiResponsesTextEvent({
      emit,
      id: "item_legacy",
      text: "Legacy answer",
      type: "text_delta",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      id: "item_legacy",
      text: "Legacy answer",
      type: "text_end",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Legacy answer");
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);

    emit({
      message: {
        content: [{ type: "text", text: "Legacy answer" }],
        role: "assistant",
      } as AssistantMessage,
      type: "message_end",
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);
  });

  it("suppresses commentary block replies until a final answer is available", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      id: "item_commentary",
      phase: "commentary",
      text: "Working...",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);

    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      id: "item_final",
      phase: "final_answer",
      text: "Done.",
    });
    await Promise.resolve();

    emitOpenAiResponsesFinalMessageEnd({ commentaryText: "Working...", emit, finalText: "Done." });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it("emits the full final answer on text_end when it extends suppressed commentary", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      id: "item_commentary",
      phase: "commentary",
      text: "Hello",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();

    emitOpenAiResponsesTextDeltaAndEnd({
      delta: " world",
      emit,
      id: "item_final",
      phase: "final_answer",
      text: "Hello world",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Hello world");
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not defer final_answer text_end when phase exists only in textSignature", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitOpenAiResponsesTextEvent({
      emit,
      id: "item_final",
      signaturePhase: "final_answer",
      text: "Done.",
      type: "text_delta",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      id: "item_final",
      signaturePhase: "final_answer",
      text: "Done.",
      type: "text_end",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it("emits the final answer at message_end when commentary was streamed first", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      id: "item_commentary",
      phase: "commentary",
      text: "Working...",
    });
    await Promise.resolve();

    emitOpenAiResponsesFinalMessageEnd({ commentaryText: "Working...", emit, finalText: "Done." });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });
});
