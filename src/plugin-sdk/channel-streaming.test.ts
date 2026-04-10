import { describe, expect, it } from "vitest";
import {
  getChannelStreamingConfigObject,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewChunk,
} from "./channel-streaming.js";

describe("channel-streaming", () => {
  it("reads canonical nested streaming config first", () => {
    const entry = {
      blockStreaming: false,
      blockStreamingCoalesce: { idleMs: 100, maxChars: 15, minChars: 5 },
      chunkMode: "length",
      draftChunk: { breakPreference: "paragraph", maxChars: 4, minChars: 2 },
      nativeStreaming: false,
      streaming: {
        block: {
          coalesce: { idleMs: 250, maxChars: 80, minChars: 40 },
          enabled: true,
        },
        chunkMode: "newline",
        nativeTransport: true,
        preview: {
          chunk: { breakPreference: "sentence", maxChars: 20, minChars: 10 },
        },
      },
    } as const;

    expect(getChannelStreamingConfigObject(entry)).toEqual(entry.streaming);
    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(true);
    expect(resolveChannelStreamingBlockEnabled(entry)).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({
      idleMs: 250,
      maxChars: 80,
      minChars: 40,
    });
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({
      breakPreference: "sentence",
      maxChars: 20,
      minChars: 10,
    });
  });

  it("falls back to legacy flat fields when the canonical object is absent", () => {
    const entry = {
      blockStreaming: true,
      blockStreamingCoalesce: { idleMs: 500, maxChars: 240, minChars: 120 },
      chunkMode: "newline",
      draftChunk: { breakPreference: "newline", maxChars: 16, minChars: 8 },
      nativeStreaming: true,
    } as const;

    expect(getChannelStreamingConfigObject(entry)).toBeUndefined();
    expect(resolveChannelStreamingChunkMode(entry)).toBe("newline");
    expect(resolveChannelStreamingNativeTransport(entry)).toBe(true);
    expect(resolveChannelStreamingBlockEnabled(entry)).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce(entry)).toEqual({
      idleMs: 500,
      maxChars: 240,
      minChars: 120,
    });
    expect(resolveChannelStreamingPreviewChunk(entry)).toEqual({
      breakPreference: "newline",
      maxChars: 16,
      minChars: 8,
    });
  });
});
