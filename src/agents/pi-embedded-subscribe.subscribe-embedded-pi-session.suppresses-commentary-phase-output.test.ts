import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

type AssistantMessageWithPhase = AssistantMessage & {
  phase?: "commentary" | "final_answer";
};

describe("subscribeEmbeddedPiSession", () => {
  it("suppresses commentary-phase assistant messages before tool use", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      blockReplyBreak: "message_end",
      onBlockReply,
      onPartialReply,
      runId: "run",
    });

    const commentaryMessage = {
      content: [{ text: "Need send.", type: "text" }],
      phase: "commentary",
      role: "assistant",
      stopReason: "toolUse",
    } as AssistantMessageWithPhase;

    emit({ message: commentaryMessage, type: "message_start" });
    emit({ message: commentaryMessage, type: "message_end" });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);
  });

  it("suppresses commentary when phase is only present in textSignature metadata", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      blockReplyBreak: "message_end",
      onBlockReply,
      onPartialReply,
      runId: "run",
    });

    const commentaryMessage = {
      content: [
        {
          text: "Need send.",
          textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
          type: "text",
        },
      ],
      role: "assistant",
      stopReason: "toolUse",
    } as AssistantMessage;

    emit({ message: commentaryMessage, type: "message_start" });
    emit({
      assistantMessageEvent: { delta: "Need send.", type: "text_delta" },
      message: commentaryMessage,
      type: "message_update",
    });
    emit({ message: commentaryMessage, type: "message_end" });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual([]);
  });
});
