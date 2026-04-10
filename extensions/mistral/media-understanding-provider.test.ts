import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.ts";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("mistralMediaUnderstandingProvider", () => {
  it("has expected provider metadata", () => {
    expect(mistralMediaUnderstandingProvider.id).toBe("mistral");
    expect(mistralMediaUnderstandingProvider.capabilities).toEqual(["audio"]);
    expect(mistralMediaUnderstandingProvider.transcribeAudio).toBeDefined();
  });

  it("uses Mistral base URL by default", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "bonjour" });

    const result = await mistralMediaUnderstandingProvider.transcribeAudio!({
      apiKey: "test-mistral-key",
      buffer: Buffer.from("audio-bytes"),
      fetchFn,
      fileName: "voice.ogg",
      timeoutMs: 5000,
    });

    expect(getRequest().url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(result.text).toBe("bonjour");
  });

  it("allows overriding baseUrl", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await mistralMediaUnderstandingProvider.transcribeAudio!({
      apiKey: "key",
      baseUrl: "https://custom.mistral.example/v1",
      buffer: Buffer.from("audio"),
      fetchFn,
      fileName: "note.mp3",
      timeoutMs: 1000,
    });

    expect(getRequest().url).toBe("https://custom.mistral.example/v1/audio/transcriptions");
  });
});
