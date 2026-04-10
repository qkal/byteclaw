import { describe, expect, it, vi } from "vitest";

const streamInstances = vi.hoisted(
  () =>
    [] as {
      hasContent: boolean;
      isFinalized: boolean;
      isFailed: boolean;
      streamedLength: number;
      sendInformativeUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      finalize: ReturnType<typeof vi.fn>;
    }[],
);

vi.mock("./streaming-message.js", () => ({
  TeamsHttpStream: class {
    hasContent = false;
    isFinalized = false;
    isFailed = false;
    streamedLength = 0;
    sendInformativeUpdate = vi.fn(async () => {});
    update = vi.fn(function  update(
      this: { hasContent: boolean; streamedLength: number },
      payloadText?: string,
    ) {
      this.hasContent = true;
      this.streamedLength = payloadText?.length ?? 0;
    });
    finalize = vi.fn(async function  finalize(this: { isFinalized: boolean }) {
      this.isFinalized = true;
    });

    constructor() {
      streamInstances.push(this as never);
    }
  },
}));

import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

describe("createTeamsReplyStreamController", () => {
  function createController() {
    streamInstances.length = 0;
    return createTeamsReplyStreamController({
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      conversationType: "personal",
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
    });
  }

  it("suppresses fallback for first text segment that was streamed", () => {
    const ctrl = createController();
    ctrl.onPartialReply({ text: "Hello world" });

    const result = ctrl.preparePayload({ text: "Hello world" });
    expect(result).toBeUndefined();
  });

  it("when stream fails after partial delivery, fallback sends only remaining text", () => {
    const ctrl = createController();
    const fullText = "a".repeat(4000) + "b".repeat(200);

    ctrl.onPartialReply({ text: fullText });
    streamInstances[0].hasContent = false;
    streamInstances[0].isFailed = true;
    streamInstances[0].isFinalized = true;
    streamInstances[0].streamedLength = 4000;

    const result = ctrl.preparePayload({ text: fullText });
    expect(result).toEqual({ text: "b".repeat(200) });
  });

  it("when stream fails before sending content, fallback sends full text", () => {
    const ctrl = createController();
    const fullText = "Failure at first chunk";

    ctrl.onPartialReply({ text: fullText });
    streamInstances[0].hasContent = false;
    streamInstances[0].isFailed = true;
    streamInstances[0].isFinalized = true;
    streamInstances[0].streamedLength = 0;

    const result = ctrl.preparePayload({ text: fullText });
    expect(result).toEqual({ text: fullText });
  });

  it("allows fallback delivery for second text segment after tool calls", () => {
    const ctrl = createController();

    // First text segment: streaming tokens arrive
    ctrl.onPartialReply({ text: "First segment" });

    // First segment complete: preparePayload suppresses (stream handled it)
    const result1 = ctrl.preparePayload({ text: "First segment" });
    expect(result1).toBeUndefined();

    // Tool calls happen... then second text segment arrives via deliver()
    // PreparePayload should allow fallback delivery for this segment
    const result2 = ctrl.preparePayload({ text: "Second segment after tools" });
    expect(result2).toEqual({ text: "Second segment after tools" });
  });

  it("finalizes the stream when suppressing first segment", () => {
    const ctrl = createController();
    ctrl.onPartialReply({ text: "Streamed text" });

    ctrl.preparePayload({ text: "Streamed text" });

    expect(streamInstances[0]?.finalize).toHaveBeenCalled();
  });

  it("uses fallback even when onPartialReply fires after stream finalized", () => {
    const ctrl = createController();

    // First text segment: streaming tokens arrive
    ctrl.onPartialReply({ text: "First segment" });

    // First segment complete: preparePayload suppresses and finalizes stream
    const result1 = ctrl.preparePayload({ text: "First segment" });
    expect(result1).toBeUndefined();
    expect(streamInstances[0]?.isFinalized).toBe(true);

    // Post-tool partial replies fire again (stream.update is a no-op since finalized)
    ctrl.onPartialReply({ text: "Second segment" });

    // Must still use fallback because stream is finalized and can't deliver
    const result2 = ctrl.preparePayload({ text: "Second segment" });
    expect(result2).toEqual({ text: "Second segment" });
  });

  it("delivers all segments across 3+ tool call rounds", () => {
    const ctrl = createController();

    // Round 1: text → tool
    ctrl.onPartialReply({ text: "Segment 1" });
    expect(ctrl.preparePayload({ text: "Segment 1" })).toBeUndefined();

    // Round 2: text → tool
    ctrl.onPartialReply({ text: "Segment 2" });
    const r2 = ctrl.preparePayload({ text: "Segment 2" });
    expect(r2).toEqual({ text: "Segment 2" });

    // Round 3: final text
    ctrl.onPartialReply({ text: "Segment 3" });
    const r3 = ctrl.preparePayload({ text: "Segment 3" });
    expect(r3).toEqual({ text: "Segment 3" });
  });

  it("passes media+text payload through fully after stream finalized", () => {
    const ctrl = createController();

    // First segment streamed and finalized
    ctrl.onPartialReply({ text: "Streamed text" });
    ctrl.preparePayload({ text: "Streamed text" });

    // Second segment has both text and media — should pass through fully
    const result = ctrl.preparePayload({
      mediaUrl: "https://example.com/tool-output.png",
      text: "Post-tool text with image",
    });
    expect(result).toEqual({
      mediaUrl: "https://example.com/tool-output.png",
      text: "Post-tool text with image",
    });
  });

  it("still strips text from media payloads when stream handled text", () => {
    const ctrl = createController();
    ctrl.onPartialReply({ text: "Some text" });

    const result = ctrl.preparePayload({
      mediaUrl: "https://example.com/image.png",
      text: "Some text",
    });
    expect(result).toEqual({
      mediaUrl: "https://example.com/image.png",
      text: undefined,
    });
  });
});
