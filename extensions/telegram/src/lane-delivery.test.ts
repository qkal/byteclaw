import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
  createLaneTextDeliverer,
} from "./lane-delivery.js";

const HELLO_FINAL = "Hello final";

function createHarness(params?: {
  answerMessageId?: number;
  draftMaxChars?: number;
  answerMessageIdAfterStop?: number;
  answerStream?: DraftLaneState["stream"];
  answerHasStreamedMessage?: boolean;
  answerLastPartialText?: string;
}) {
  const answer =
    params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId });
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      hasStreamedMessage: params?.answerHasStreamedMessage ?? false,
      lastPartialText: params?.answerLastPartialText ?? "",
      stream: answer,
    },
    reasoning: {
      hasStreamedMessage: false,
      lastPartialText: "",
      stream: reasoning as DraftLaneState["stream"],
    },
  };
  const sendPayload = vi.fn().mockResolvedValue(true);
  const flushDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.flush();
  });
  const stopDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    if (lane === lanes.answer && params?.answerMessageIdAfterStop !== undefined) {
      (answer as { setMessageId?: (value: number | undefined) => void }).setMessageId?.(
        params.answerMessageIdAfterStop,
      );
    }
    await lane.stream?.stop();
  });
  const editPreview = vi.fn().mockResolvedValue(undefined);
  const deletePreviewMessage = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const markDelivered = vi.fn();
  const activePreviewLifecycleByLane = { answer: "transient", reasoning: "transient" } as const;
  const retainPreviewOnCleanupByLane = { answer: false, reasoning: false } as const;
  const archivedAnswerPreviews: {
    messageId: number;
    textSnapshot: string;
    deleteIfUnused?: boolean;
  }[] = [];

  const deliverLaneText = createLaneTextDeliverer({
    activePreviewLifecycleByLane: { ...activePreviewLifecycleByLane },
    applyTextToPayload: (payload: ReplyPayload, text: string) => ({ ...payload, text }),
    archivedAnswerPreviews,
    deletePreviewMessage,
    draftMaxChars: params?.draftMaxChars ?? 4096,
    editPreview,
    flushDraftLane,
    lanes,
    log,
    markDelivered,
    retainPreviewOnCleanupByLane: { ...retainPreviewOnCleanupByLane },
    sendPayload,
    stopDraftLane,
  });

  return {
    answer: {
      setMessageId: (answer as { setMessageId?: (value: number | undefined) => void }).setMessageId,
      stream: answer,
    },
    archivedAnswerPreviews,
    deletePreviewMessage,
    deliverLaneText,
    editPreview,
    flushDraftLane,
    lanes,
    log,
    markDelivered,
    sendPayload,
    stopDraftLane,
  };
}

async function deliverFinalAnswer(harness: ReturnType<typeof createHarness>, text: string) {
  return harness.deliverLaneText({
    infoKind: "final",
    laneName: "answer",
    payload: { text },
    text,
  });
}

async function expectFinalPreviewRetained(params: {
  harness: ReturnType<typeof createHarness>;
  text?: string;
  expectedLogSnippet?: string;
}) {
  const result = await deliverFinalAnswer(params.harness, params.text ?? HELLO_FINAL);
  expect(result.kind).toBe("preview-retained");
  expect(params.harness.sendPayload).not.toHaveBeenCalled();
  if (params.expectedLogSnippet) {
    expect(params.harness.log).toHaveBeenCalledWith(
      expect.stringContaining(params.expectedLogSnippet),
    );
  }
}

function seedArchivedAnswerPreview(harness: ReturnType<typeof createHarness>) {
  harness.archivedAnswerPreviews.push({
    deleteIfUnused: true,
    messageId: 5555,
    textSnapshot: "Partial streaming...",
  });
}

async function expectFinalEditFallbackToSend(params: {
  harness: ReturnType<typeof createHarness>;
  text: string;
  expectedLogSnippet: string;
}) {
  const result = await deliverFinalAnswer(params.harness, params.text);
  expect(result.kind).toBe("sent");
  expect(params.harness.editPreview).toHaveBeenCalledTimes(1);
  expect(params.harness.sendPayload).toHaveBeenCalledWith(
    expect.objectContaining({ text: params.text }),
  );
  expect(params.harness.log).toHaveBeenCalledWith(
    expect.stringContaining(params.expectedLogSnippet),
  );
}

function expectPreviewFinalized(
  result: LaneDeliveryResult,
): Extract<LaneDeliveryResult, { kind: "preview-finalized" }>["delivery"] {
  expect(result.kind).toBe("preview-finalized");
  if (result.kind !== "preview-finalized") {
    throw new Error(`expected preview-finalized, got ${result.kind}`);
  }
  return result.delivery;
}

describe("createLaneTextDeliverer", () => {
  it("finalizes text-only replies by editing an existing preview message", async () => {
    const harness = createHarness({ answerMessageId: 999 });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(expectPreviewFinalized(result)).toEqual({ content: HELLO_FINAL, messageId: 999 });
    expect(harness.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "final",
        laneName: "answer",
        messageId: 999,
        text: HELLO_FINAL,
      }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
  });

  it("primes stop-created previews with final text before editing", async () => {
    const harness = createHarness({ answerMessageIdAfterStop: 777 });
    harness.lanes.answer.lastPartialText = "no";

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "no problem" },
      text: "no problem",
    });

    expect(expectPreviewFinalized(result)).toEqual({ content: "no problem", messageId: 777 });
    expect(harness.answer.stream?.update).toHaveBeenCalledWith("no problem");
    expect(harness.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        laneName: "answer",
        messageId: 777,
        text: "no problem",
      }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("keeps stop-created preview when follow-up final edit fails", async () => {
    const harness = createHarness({ answerMessageIdAfterStop: 777 });
    harness.editPreview.mockRejectedValue(new Error("500: edit failed after stop flush"));

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "Short final" },
      text: "Short final",
    });

    expect(result.kind).toBe("preview-retained");
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("failed after stop flush; keeping existing preview"),
    );
  });

  it("treats 'message is not modified' preview edit errors as delivered", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(
      new Error(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(expectPreviewFinalized(result)).toEqual({ content: HELLO_FINAL, messageId: 999 });
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining('edit returned "message is not modified"; treating as delivered'),
    );
  });

  it("retains preview when an existing preview final edit fails with ambiguous error", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    // Plain Error with no error_code → ambiguous, prefer incomplete over duplicate
    harness.editPreview.mockRejectedValue(new Error("500: preview edit failed"));

    await expectFinalPreviewRetained({
      expectedLogSnippet: "ambiguous error; keeping existing preview to avoid duplicate",
      harness,
    });
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
  });

  it("falls back when Telegram reports the current final edit target missing", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    await expectFinalEditFallbackToSend({
      expectedLogSnippet: "edit target missing with no alternate preview; falling back",
      harness,
      text: "Hello final",
    });
  });

  it("falls back to sendPayload when the final edit fails before reaching Telegram", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    harness.editPreview.mockRejectedValue(err);

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: HELLO_FINAL }),
    );
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("failed before reaching Telegram; falling back"),
    );
  });

  it("keeps preview when the final edit times out after the request may have landed", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(new Error("timeout: request timed out after 30000ms"));

    await expectFinalPreviewRetained({
      expectedLogSnippet: "may have landed despite network error; keeping existing preview",
      harness,
    });
  });

  it("falls back to normal delivery when stop-created preview has no message id", async () => {
    const harness = createHarness();

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "Short final" },
      text: "Short final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Short final" }),
    );
  });

  it("keeps existing preview when final text regresses", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.lastPartialText = "Recovered final answer.";

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "Recovered final answer" },
      text: "Recovered final answer",
    });

    expect(expectPreviewFinalized(result)).toEqual({
      content: "Recovered final answer.",
      messageId: 999,
    });
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal delivery when final text exceeds preview edit limit", async () => {
    const harness = createHarness({ answerMessageId: 999, draftMaxChars: 20 });
    const longText = "x".repeat(50);

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: longText },
      text: longText,
    });

    expect(result.kind).toBe("sent");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(expect.objectContaining({ text: longText }));
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("preview final too long"));
  });

  it("materializes DM draft streaming final even when text is unchanged", async () => {
    const answerStream = createTestDraftStream({ messageId: 321, previewMode: "draft" });
    answerStream.materialize.mockResolvedValue(321);
    answerStream.update.mockImplementation(() => {});
    const harness = createHarness({
      answerHasStreamedMessage: true,
      answerLastPartialText: "Hello final",
      answerStream: answerStream as DraftLaneState["stream"],
    });

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "Hello final" },
      text: "Hello final",
    });

    expect(expectPreviewFinalized(result)).toEqual({ content: "Hello final", messageId: 321 });
    expect(harness.flushDraftLane).toHaveBeenCalled();
    expect(answerStream.materialize).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("materializes DM draft streaming final when revision changes", async () => {
    let previewRevision = 3;
    const answerStream = createTestDraftStream({ messageId: 654, previewMode: "draft" });
    answerStream.materialize.mockResolvedValue(654);
    answerStream.previewRevision.mockImplementation(() => previewRevision);
    answerStream.update.mockImplementation(() => {});
    answerStream.flush.mockImplementation(async () => {
      previewRevision += 1;
    });
    const harness = createHarness({
      answerHasStreamedMessage: true,
      answerLastPartialText: "Final answer",
      answerStream: answerStream as DraftLaneState["stream"],
    });

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "Final answer" },
      text: "Final answer",
    });

    expect(expectPreviewFinalized(result)).toEqual({ content: "Final answer", messageId: 654 });
    expect(answerStream.materialize).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal send when draft materialize returns no message id", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.materialize.mockResolvedValue(undefined);
    const harness = createHarness({
      answerHasStreamedMessage: true,
      answerLastPartialText: "Hello final",
      answerStream: answerStream as DraftLaneState["stream"],
    });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(answerStream.materialize).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: HELLO_FINAL }),
    );
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("draft preview materialize produced no message id"),
    );
  });

  it("does not use DM draft final shortcut for media payloads", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    const harness = createHarness({
      answerHasStreamedMessage: true,
      answerLastPartialText: "Image incoming",
      answerStream: answerStream as DraftLaneState["stream"],
    });

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { mediaUrl: "file:///tmp/example.png", text: "Image incoming" },
      text: "Image incoming",
    });

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "file:///tmp/example.png", text: "Image incoming" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });

  it("does not use DM draft final shortcut when inline buttons are present", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    const harness = createHarness({
      answerHasStreamedMessage: true,
      answerLastPartialText: "Choose one",
      answerStream: answerStream as DraftLaneState["stream"],
    });

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { text: "Choose one" },
      previewButtons: [[{ callback_data: "ok", text: "OK" }]],
      text: "Choose one",
    });

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Choose one" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });

  // ── Duplicate message regression tests ──────────────────────────────────
  // During final delivery, only ambiguous post-connect failures keep the
  // Preview. Definite non-delivery falls back to a real send.

  it("retains preview on ambiguous API error during final", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    // Plain Error with no error_code → ambiguous, prefer incomplete over duplicate
    harness.editPreview.mockRejectedValue(new Error("500: Internal Server Error"));

    await expectFinalPreviewRetained({ harness });
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
  });

  it("falls back when an archived preview edit target is missing and no alternate preview exists", async () => {
    const harness = createHarness();
    seedArchivedAnswerPreview(harness);
    harness.editPreview.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    const result = await deliverFinalAnswer(harness, "Complete final answer");

    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Complete final answer" }),
    );
    expect(result.kind).toBe("sent");
    expect(harness.deletePreviewMessage).toHaveBeenCalledWith(5555);
  });

  it("keeps the active preview when an archived final edit target is missing", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    seedArchivedAnswerPreview(harness);
    harness.editPreview.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    const result = await deliverFinalAnswer(harness, "Complete final answer");

    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(result.kind).toBe("preview-retained");
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("edit target missing; keeping alternate preview without fallback"),
    );
  });

  it("keeps the archived preview when the final text regresses", async () => {
    const harness = createHarness();
    harness.archivedAnswerPreviews.push({
      deleteIfUnused: true,
      messageId: 5555,
      textSnapshot: "Recovered final answer.",
    });

    const result = await deliverFinalAnswer(harness, "Recovered final answer");

    expect(expectPreviewFinalized(result)).toEqual({
      content: "Recovered final answer.",
      messageId: 5555,
    });
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("falls back on 4xx client rejection with error_code during final", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const err = Object.assign(new Error("403: Forbidden"), { error_code: 403 });
    harness.editPreview.mockRejectedValue(err);

    await expectFinalEditFallbackToSend({
      expectedLogSnippet: "rejected by Telegram (client error); falling back",
      harness,
      text: "Hello final",
    });
  });

  it("retains preview on 502 with error_code during final (ambiguous server error)", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const err = Object.assign(new Error("502: Bad Gateway"), { error_code: 502 });
    harness.editPreview.mockRejectedValue(err);

    await expectFinalPreviewRetained({
      expectedLogSnippet: "ambiguous error; keeping existing preview to avoid duplicate",
      harness,
    });
  });

  it("falls back when the first preview send may have landed without a message id", async () => {
    const stream = createTestDraftStream();
    stream.sendMayHaveLanded.mockReturnValue(true);
    const harness = createHarness({ answerStream: stream });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: HELLO_FINAL }),
    );
  });

  it("retains when sendMayHaveLanded is true and a prior preview was visible", async () => {
    // Stream has a messageId (visible preview) but loses it after stop
    const stream = createTestDraftStream({ messageId: 999 });
    stream.sendMayHaveLanded.mockReturnValue(true);
    const harness = createHarness({
      answerHasStreamedMessage: true,
      answerStream: stream,
    });
    // Simulate messageId lost after stop (e.g. forceNewMessage or timeout)
    harness.stopDraftLane.mockImplementation(async (lane: DraftLaneState) => {
      stream.setMessageId(undefined);
      await lane.stream?.stop();
    });

    await expectFinalPreviewRetained({
      expectedLogSnippet: "preview send may have landed despite missing message id",
      harness,
    });
  });

  it("deletes consumed boundary previews after fallback final send", async () => {
    const harness = createHarness();
    harness.archivedAnswerPreviews.push({
      deleteIfUnused: false,
      messageId: 4444,
      textSnapshot: "Boundary preview",
    });

    const result = await harness.deliverLaneText({
      infoKind: "final",
      laneName: "answer",
      payload: { mediaUrl: "file:///tmp/example.png", text: "Final with media" },
      text: "Final with media",
    });

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "file:///tmp/example.png", text: "Final with media" }),
    );
    expect(harness.deletePreviewMessage).toHaveBeenCalledWith(4444);
  });
});
