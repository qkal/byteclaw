import { describe, expect, it, vi } from "vitest";
import {
  sendPayloadMediaSequenceAndFinalize,
  sendPayloadMediaSequenceOrFallback,
} from "./direct-text-media.js";

describe("sendPayloadMediaSequenceOrFallback", () => {
  it("uses the no-media sender when no media entries exist", async () => {
    const send = vi.fn();
    const sendNoMedia = vi.fn(async () => ({ messageId: "text-1" }));

    await expect(
      sendPayloadMediaSequenceOrFallback({
        fallbackResult: { messageId: "" },
        mediaUrls: [],
        send,
        sendNoMedia,
        text: "hello",
      }),
    ).resolves.toEqual({ messageId: "text-1" });

    expect(send).not.toHaveBeenCalled();
    expect(sendNoMedia).toHaveBeenCalledOnce();
  });

  it("returns the last media send result and clears text after the first media", async () => {
    const calls: { text: string; mediaUrl: string; isFirst: boolean }[] = [];

    await expect(
      sendPayloadMediaSequenceOrFallback({
        fallbackResult: { messageId: "" },
        mediaUrls: ["a", "b"],
        send: async ({ text, mediaUrl, isFirst }) => {
          calls.push({ isFirst, mediaUrl, text });
          return { messageId: mediaUrl };
        },
        text: "caption",
      }),
    ).resolves.toEqual({ messageId: "b" });

    expect(calls).toEqual([
      { isFirst: true, mediaUrl: "a", text: "caption" },
      { isFirst: false, mediaUrl: "b", text: "" },
    ]);
  });
});

describe("sendPayloadMediaSequenceAndFinalize", () => {
  it("skips media sends and finalizes directly when no media entries exist", async () => {
    const send = vi.fn();
    const finalize = vi.fn(async () => ({ messageId: "final-1" }));

    await expect(
      sendPayloadMediaSequenceAndFinalize({
        finalize,
        mediaUrls: [],
        send,
        text: "hello",
      }),
    ).resolves.toEqual({ messageId: "final-1" });

    expect(send).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("sends the media sequence before the finalizing send", async () => {
    const send = vi.fn(async ({ mediaUrl }: { mediaUrl: string }) => ({ messageId: mediaUrl }));
    const finalize = vi.fn(async () => ({ messageId: "final-2" }));

    await expect(
      sendPayloadMediaSequenceAndFinalize({
        finalize,
        mediaUrls: ["a", "b"],
        send,
        text: "",
      }),
    ).resolves.toEqual({ messageId: "final-2" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledOnce();
  });
});
