import { describe, expect, it } from "vitest";
import {
  createSlackTurnDeliveryTracker,
  isSlackStreamingEnabled,
  resolveSlackStreamingThreadHint,
  shouldEnableSlackPreviewStreaming,
  shouldInitializeSlackDraftStream,
} from "./dispatch.js";

describe("slack native streaming defaults", () => {
  it("is enabled for partial mode when native streaming is on", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: true })).toBe(true);
  });

  it("is disabled outside partial mode or when native streaming is off", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: false })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "block", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "progress", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "off", nativeStreaming: true })).toBe(false);
  });
});

describe("slack turn delivery tracker", () => {
  it("treats repeated text payloads on the same thread as duplicates", () => {
    const tracker = createSlackTurnDeliveryTracker();
    const payload = { text: "same reply" };

    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "123.456" })).toBe(false);
    tracker.markDelivered({ kind: "final", payload, threadTs: "123.456" });
    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "123.456" })).toBe(true);
    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "other-thread" })).toBe(false);
  });

  it("keeps explicit reply targets distinct from the shared thread target", () => {
    const tracker = createSlackTurnDeliveryTracker();

    tracker.markDelivered({
      kind: "final",
      payload: { replyToId: "thread-A", text: "same reply" },
      threadTs: "123.456",
    });

    expect(
      tracker.hasDelivered({
        kind: "final",
        payload: { replyToId: "thread-B", text: "same reply" },
        threadTs: "123.456",
      }),
    ).toBe(false);
  });

  it("keeps distinct dispatch kinds separate for identical payloads", () => {
    const tracker = createSlackTurnDeliveryTracker();
    const payload = { text: "same reply" };

    tracker.markDelivered({ kind: "tool", payload, threadTs: "123.456" });

    expect(tracker.hasDelivered({ kind: "tool", payload, threadTs: "123.456" })).toBe(true);
    expect(tracker.hasDelivered({ kind: "final", payload, threadTs: "123.456" })).toBe(false);
  });
});

describe("slack native streaming thread hint", () => {
  it("stays off-thread when replyToMode=off and message is not in a thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        incomingThreadTs: undefined,
        messageTs: "1000.1",
        replyToMode: "off",
      }),
    ).toBeUndefined();
  });

  it("uses first-reply thread when replyToMode=first", () => {
    expect(
      resolveSlackStreamingThreadHint({
        incomingThreadTs: undefined,
        messageTs: "1000.2",
        replyToMode: "first",
      }),
    ).toBe("1000.2");
  });

  it("uses the existing incoming thread regardless of replyToMode", () => {
    expect(
      resolveSlackStreamingThreadHint({
        incomingThreadTs: "2000.1",
        messageTs: "1000.3",
        replyToMode: "off",
      }),
    ).toBe("2000.1");
  });
});

describe("slack preview streaming eligibility", () => {
  it("stays on for room messages when streaming mode is enabled", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        isDirectMessage: false,
        mode: "partial",
      }),
    ).toBe(true);
  });

  it("stays off for top-level DMs without a reply thread", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        isDirectMessage: true,
        mode: "partial",
      }),
    ).toBe(false);
  });

  it("allows DM preview when the reply is threaded", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        isDirectMessage: true,
        mode: "partial",
        threadTs: "1000.1",
      }),
    ).toBe(true);
  });

  it("keeps top-level DMs off even when replyToMode would create a reply thread", () => {
    const streamThreadHint = resolveSlackStreamingThreadHint({
      incomingThreadTs: undefined,
      isThreadReply: false,
      messageTs: "1000.4",
      replyToMode: "all",
    });

    expect(
      shouldEnableSlackPreviewStreaming({
        isDirectMessage: true,
        mode: "partial",
        threadTs: undefined,
      }),
    ).toBe(false);
    expect(streamThreadHint).toBe("1000.4");
  });
});

describe("slack draft stream initialization", () => {
  it("stays off when preview streaming is disabled", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: false,
        useStreaming: false,
      }),
    ).toBe(false);
  });

  it("stays off when native streaming is active", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: true,
        useStreaming: true,
      }),
    ).toBe(false);
  });

  it("turns on only for preview-only paths", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: true,
        useStreaming: false,
      }),
    ).toBe(true);
  });
});
