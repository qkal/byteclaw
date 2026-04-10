import { describe, expect, it } from "vitest";
import {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.ts";
import { transcribeDeepgramAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeDeepgramAudio", () => {
  it("respects lowercase authorization header overrides", async () => {
    const { fetchFn, getAuthHeader } = createAuthCaptureJsonFetch({
      results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
    });

    const result = await transcribeDeepgramAudio({
      apiKey: "test-key",
      buffer: Buffer.from("audio"),
      fetchFn,
      fileName: "note.mp3",
      headers: { authorization: "Token override" },
      timeoutMs: 1000,
    });

    expect(getAuthHeader()).toBe("Token override");
    expect(result.text).toBe("ok");
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      results: { channels: [{ alternatives: [{ transcript: "hello" }] }] },
    });

    const result = await transcribeDeepgramAudio({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1/",
      buffer: Buffer.from("audio-bytes"),
      fetchFn,
      fileName: "voice.wav",
      headers: { "X-Custom": "1" },
      language: " en ",
      mime: "audio/wav",
      model: " ",
      query: {
        punctuate: false,
        smart_format: true,
      },
      timeoutMs: 1234,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("nova-3");
    expect(result.text).toBe("hello");
    expect(seenUrl).toBe(
      "https://api.example.com/v1/listen?model=nova-3&language=en&punctuate=false&smart_format=true",
    );
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Token test-key");
    expect(headers.get("x-custom")).toBe("1");
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(seenInit?.body).toBeInstanceOf(Uint8Array);
  });

  it("throws when the provider response omits transcript", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      results: { channels: [{ alternatives: [{}] }] },
    });

    await expect(
      transcribeDeepgramAudio({
        apiKey: "test-key",
        buffer: Buffer.from("audio-bytes"),
        fetchFn,
        fileName: "voice.wav",
        timeoutMs: 1234,
      }),
    ).rejects.toThrow("Audio transcription response missing transcript");
  });
});
