import { describe, expect, it, vi } from "vitest";
import {
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("keeps assistantTexts to the final answer when block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedPiSession({
      reasoningMode: "on",
      runId: "run",
      session,
    });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "Final ", emit });
    emitAssistantTextDelta({ delta: "answer", emit });
    emitAssistantTextEnd({ emit });

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ message: assistantMessage, type: "message_end" });

    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
  it("suppresses partial replies when reasoning is enabled and block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    const subscription = subscribeEmbeddedPiSession({
      onPartialReply,
      reasoningMode: "on",
      runId: "run",
      session,
    });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "Draft ", emit });
    emitAssistantTextDelta({ delta: "reply", emit });

    expect(onPartialReply).not.toHaveBeenCalled();

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ message: assistantMessage, type: "message_end" });
    emitAssistantTextEnd({ content: "Draft reply", emit });

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
});
