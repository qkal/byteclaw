import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.ts";
import { transcribeOpenAiAudio } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("transcribeOpenAiAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({ text: "ok" });

    const result = await transcribeOpenAiAudio({
      apiKey: "test-key",
      buffer: Buffer.from("audio"),
      fetchFn,
      fileName: "note.mp3",
      headers: { authorization: "Bearer override" },
      timeoutMs: 1000,
    });

    expect(getAuthHeader()).toBe("Bearer override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });

    const result = await transcribeOpenAiAudio({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1/",
      buffer: Buffer.from("audio-bytes"),
      fetchFn,
      fileName: "voice.wav",
      headers: { "X-Custom": "1" },
      language: " en ",
      mime: "audio/wav",
      model: " ",
      prompt: " hello ",
      timeoutMs: 1234,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gpt-4o-transcribe");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-custom")).toBe("1");

    const form = seenInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("hello");
    const file = form.get("file") as Blob | { type?: string; name?: string } | null;
    expect(file).not.toBeNull();
    if (file) {
      expect(file.type).toBe("audio/wav");
      if ("name" in file && typeof file.name === "string") {
        expect(file.name).toBe("voice.wav");
      }
    }
  });

  it("throws when the provider response omits text", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({});

    await expect(
      transcribeOpenAiAudio({
        apiKey: "test-key",
        buffer: Buffer.from("audio-bytes"),
        fetchFn,
        fileName: "voice.wav",
        timeoutMs: 1234,
      }),
    ).rejects.toThrow("Audio transcription response missing text");
  });
});
