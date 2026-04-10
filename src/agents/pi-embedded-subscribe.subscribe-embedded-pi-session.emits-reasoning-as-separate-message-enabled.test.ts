import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  THINKING_TAG_CASES,
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  function createReasoningBlockReplyHarness() {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      blockReplyBreak: "message_end",
      onBlockReply,
      reasoningMode: "on",
      runId: "run",
      session,
    });

    return { emit, onBlockReply };
  }

  function expectReasoningAndAnswerCalls(onBlockReply: ReturnType<typeof vi.fn>) {
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Reasoning:\n_Because it helps_");
    expect(onBlockReply.mock.calls[1][0].text).toBe("Final answer");
  }

  it("emits reasoning as a separate message when enabled", () => {
    const { emit, onBlockReply } = createReasoningBlockReplyHarness();

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ message: assistantMessage, type: "message_end" });

    expectReasoningAndAnswerCalls(onBlockReply);
  });
  it.each(THINKING_TAG_CASES)(
    "promotes <%s> tags to thinking blocks at write-time",
    ({ open, close }) => {
      const { emit, onBlockReply } = createReasoningBlockReplyHarness();

      const assistantMessage = {
        content: [
          {
            text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
            type: "text",
          },
        ],
        role: "assistant",
      } as AssistantMessage;

      emit({ message: assistantMessage, type: "message_end" });

      expectReasoningAndAnswerCalls(onBlockReply);

      expect(assistantMessage.content).toEqual([
        { thinking: "Because it helps", type: "thinking" },
        { text: "Final answer", type: "text" },
      ]);
    },
  );
});
