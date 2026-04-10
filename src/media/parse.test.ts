import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

describe("splitMediaFromOutput", () => {
  function expectParsedMediaOutputCase(
    input: string,
    expected: {
      mediaUrls?: string[];
      text?: string;
      audioAsVoice?: boolean;
    },
  ) {
    const result = splitMediaFromOutput(input);
    expect(result.text).toBe(expected.text ?? "");
    if ("audioAsVoice" in expected) {
      expect(result.audioAsVoice).toBe(expected.audioAsVoice);
    } else {
      expect(result.audioAsVoice).toBeUndefined();
    }
    if ("mediaUrls" in expected) {
      expect(result.mediaUrls).toEqual(expected.mediaUrls);
      expect(result.mediaUrl).toBe(expected.mediaUrls?.[0]);
    } else {
      expect(result.mediaUrls).toBeUndefined();
      expect(result.mediaUrl).toBeUndefined();
    }
  }

  function expectStableAudioAsVoiceDetectionCase(input: string) {
    for (const output of [splitMediaFromOutput(input), splitMediaFromOutput(input)]) {
      expect(output.audioAsVoice).toBe(true);
    }
  }

  function expectAcceptedMediaPathCase(expectedPath: string, input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: [expectedPath] });
  }

  function expectRejectedMediaPathCase(input: string) {
    expectParsedMediaOutputCase(input, { mediaUrls: undefined });
  }

  it.each([
    ["/Users/pete/My File.png", "MEDIA:/Users/pete/My File.png"],
    ["/Users/pete/My File.png", 'MEDIA:"/Users/pete/My File.png"'],
    ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
    ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
    ["./screenshot.png", "  MEDIA:./screenshot.png"],
    [String.raw`C:\Users\pete\Pictures\snap.png`, String.raw`MEDIA:C:\Users\pete\Pictures\snap.png`],
    ["/tmp/tts-fAJy8C/voice-1770246885083.opus", "MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus"],
    ["image.png", "MEDIA:image.png"],
  ] as const)("accepts supported media path variant: %s", (expectedPath, input) => {
    expectAcceptedMediaPathCase(expectedPath, input);
  });

  it.each([
    "MEDIA:../../../etc/passwd",
    "MEDIA:../../.env",
    "MEDIA:~/.ssh/id_rsa",
    "MEDIA:~/Pictures/My File.png",
    "MEDIA:./foo/../../../etc/shadow",
  ] as const)("rejects traversal and home-dir path: %s", (input) => {
    expectRejectedMediaPathCase(input);
  });

  it.each([
    {
      expected: { audioAsVoice: true, text: "Hello world" },
      input: "Hello [[audio_as_voice]] world",
      name: "detects audio_as_voice tag and strips it",
    },
    {
      expected: { mediaUrls: undefined, text: "The MEDIA: tag fails to deliver" },
      input: "The MEDIA: tag fails to deliver",
      name: "keeps MEDIA mentions in prose",
    },
    {
      expected: { mediaUrls: undefined, text: "MEDIA:screenshot" },
      input: "MEDIA:screenshot",
      name: "rejects bare words without file extensions",
    },
    {
      assertStable: true,
      expected: { audioAsVoice: true, text: "Hello" },
      input: "Hello [[audio_as_voice]]",
      name: "keeps audio_as_voice detection stable across calls",
    },
  ] as const)("$name", ({ input, expected, assertStable }) => {
    expectParsedMediaOutputCase(input, expected);
    if (assertStable) {
      expectStableAudioAsVoiceDetectionCase(input);
    }
  });
});
