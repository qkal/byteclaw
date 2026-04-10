import { describe, expect, it } from "vitest";
import { parseFfprobeCodecAndSampleRate, parseFfprobeCsvFields } from "./ffmpeg-exec.js";

describe("parseFfprobeCsvFields", () => {
  function expectParsedFfprobeCsvCase(input: string, fieldCount: number, expected: string[]) {
    expect(parseFfprobeCsvFields(input, fieldCount)).toEqual(expected);
  }

  it.each([
    { expected: ["opus", "48000"], fieldCount: 2, input: "opus,\n48000\n" },
    { expected: ["opus", "48000", "stereo"], fieldCount: 3, input: "opus,48000,stereo\n" },
  ] as const)("splits ffprobe csv output %#", ({ input, fieldCount, expected }) => {
    expectParsedFfprobeCsvCase(input, fieldCount, [...expected]);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  function expectParsedCodecAndSampleRateCase(
    input: string,
    expected: { codec: string | null; sampleRateHz: number | null },
  ) {
    expect(parseFfprobeCodecAndSampleRate(input)).toEqual(expected);
  }

  it.each([
    {
      expected: {
        codec: "opus",
        sampleRateHz: 48_000,
      },
      input: "Opus,48000\n",
      name: "normalizes codec casing and parses numeric sample rates",
    },
    {
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
      input: "opus,not-a-number",
      name: "keeps codec when the sample rate is not numeric",
    },
  ] as const)("$name", ({ input, expected }) => {
    expectParsedCodecAndSampleRateCase(input, expected);
  });
});
