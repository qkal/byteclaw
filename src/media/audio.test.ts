import { describe, expect, it } from "vitest";
import {
  TELEGRAM_VOICE_AUDIO_EXTENSIONS,
  TELEGRAM_VOICE_MIME_TYPES,
  isVoiceCompatibleAudio,
} from "./audio.js";

describe("isVoiceCompatibleAudio", () => {
  function expectVoiceCompatibilityCase(
    opts: Parameters<typeof isVoiceCompatibleAudio>[0],
    expected: boolean,
  ) {
    expect(isVoiceCompatibleAudio(opts)).toBe(expected);
  }

  function expectVoiceCompatibilityCases(
    cases: readonly {
      opts: Parameters<typeof isVoiceCompatibleAudio>[0];
      expected: boolean;
    }[],
  ) {
    cases.forEach(({ opts, expected }) => {
      expectVoiceCompatibilityCase(opts, expected);
    });
  }

  it.each([
    {
      cases: [
        ...Array.from(TELEGRAM_VOICE_MIME_TYPES, (contentType) => ({
          expected: true,
          opts: { contentType, fileName: null },
        })),
        { expected: true, opts: { contentType: "audio/ogg; codecs=opus", fileName: null } },
        { expected: true, opts: { contentType: "audio/mp4; codecs=mp4a.40.2", fileName: null } },
      ],
      name: "returns true for supported MIME types",
    },
    {
      cases: Array.from(TELEGRAM_VOICE_AUDIO_EXTENSIONS, (ext) => ({
        expected: true,
        opts: { fileName: `voice${ext}` },
      })),
      name: "returns true for supported extensions",
    },
    {
      cases: [
        { expected: false, opts: { contentType: "audio/wav", fileName: null } },
        { expected: false, opts: { contentType: "audio/flac", fileName: null } },
        { expected: false, opts: { contentType: "audio/aac", fileName: null } },
        { expected: false, opts: { contentType: "video/mp4", fileName: null } },
      ],
      name: "returns false for unsupported MIME types",
    },
    {
      cases: [".wav", ".flac", ".webm"].map((ext) => ({
        expected: false,
        opts: { fileName: `audio${ext}` },
      })),
      name: "returns false for unsupported extensions",
    },
    {
      cases: [
        {
          expected: false,
          opts: {},
        },
        {
          expected: true,
          opts: { contentType: "audio/mpeg", fileName: "file.wav" },
        },
      ],
      name: "keeps fallback edge cases explicit",
    },
  ])("$name", ({ cases }) => {
    expectVoiceCompatibilityCases(cases);
  });
});
