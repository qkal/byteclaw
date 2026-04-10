import { describe, expect, it } from "vitest";
import { formatMediaUnderstandingBody } from "./format.js";

describe("formatMediaUnderstandingBody", () => {
  it("replaces placeholder body with transcript", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:audio>",
      outputs: [
        {
          attachmentIndex: 0,
          kind: "audio.transcription",
          provider: "groq",
          text: "hello world",
        },
      ],
    });
    expect(body).toBe("[Audio]\nTranscript:\nhello world");
  });

  it("includes user text when body is meaningful", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [
        {
          attachmentIndex: 0,
          kind: "audio.transcription",
          provider: "groq",
          text: "transcribed",
        },
      ],
    });
    expect(body).toBe("[Audio]\nUser text:\ncaption here\nTranscript:\ntranscribed");
  });

  it("strips leading media placeholders from user text", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:audio> caption here",
      outputs: [
        {
          attachmentIndex: 0,
          kind: "audio.transcription",
          provider: "groq",
          text: "transcribed",
        },
      ],
    });
    expect(body).toBe("[Audio]\nUser text:\ncaption here\nTranscript:\ntranscribed");
  });

  it("keeps user text once when multiple outputs exist", () => {
    const body = formatMediaUnderstandingBody({
      body: "caption here",
      outputs: [
        {
          attachmentIndex: 0,
          kind: "audio.transcription",
          provider: "groq",
          text: "audio text",
        },
        {
          attachmentIndex: 1,
          kind: "video.description",
          provider: "google",
          text: "video text",
        },
      ],
    });
    expect(body).toBe(
      [
        "User text:\ncaption here",
        "[Audio]\nTranscript:\naudio text",
        "[Video]\nDescription:\nvideo text",
      ].join("\n\n"),
    );
  });

  it("formats image outputs", () => {
    const body = formatMediaUnderstandingBody({
      body: "<media:image>",
      outputs: [
        {
          attachmentIndex: 0,
          kind: "image.description",
          provider: "openai",
          text: "a cat",
        },
      ],
    });
    expect(body).toBe("[Image]\nDescription:\na cat");
  });
});
