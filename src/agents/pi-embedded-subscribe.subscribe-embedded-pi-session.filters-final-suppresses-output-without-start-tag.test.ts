import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("filters to <final> and suppresses output without a start tag", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      enforceFinalTag: true,
      onAgentEvent,
      onPartialReply,
      runId: "run",
      session,
    });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "<final>Hi there</final>", emit });

    expect(onPartialReply).toHaveBeenCalled();
    const firstPayload = onPartialReply.mock.calls[0][0];
    expect(firstPayload.text).toBe("Hi there");

    onPartialReply.mockClear();

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "</final>Oops no start", emit });

    expect(onPartialReply).not.toHaveBeenCalled();
  });
  it("suppresses agent events on message_end without <final> tags when enforced", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      enforceFinalTag: true,
      onAgentEvent,
      runId: "run",
      session,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    // With enforceFinalTag, text without <final> tags is treated as leaked
    // Reasoning and should NOT be recovered by the message_end fallback.
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(0);
  });
  it("emits via streaming when <final> tags are present and enforcement is on", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      enforceFinalTag: true,
      onAgentEvent,
      onPartialReply,
      runId: "run",
      session,
    });

    // With enforceFinalTag, content is emitted via streaming (text_delta path),
    // NOT recovered from message_end fallback. extractAssistantText strips
    // <final> tags, so message_end would see plain text with no <final> markers
    // And correctly suppress it (treated as reasoning leak).
    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta({ delta: "<final>Hello world</final>", emit });

    expect(onPartialReply).toHaveBeenCalled();
    expect(onPartialReply.mock.calls[0][0].text).toBe("Hello world");
  });
  it("does not require <final> when enforcement is off", () => {
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedPiSession({
      onPartialReply,
      runId: "run",
      session,
    });

    emitAssistantTextDelta({ delta: "Hello world", emit });

    const payload = onPartialReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello world");
  });
  it("emits block replies on message_end", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      blockReplyBreak: "message_end",
      onBlockReply,
      runId: "run",
      session,
    });

    const assistantMessage = {
      content: [{ text: "Hello block", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessage, type: "message_end" });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalled();
    const payload = onBlockReply.mock.calls[0][0];
    expect(payload.text).toBe("Hello block");
  });
});
