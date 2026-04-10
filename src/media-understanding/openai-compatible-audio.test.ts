import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

installPinnedHostnameTestHooks();

describe("transcribeOpenAiCompatibleAudio", () => {
  it("adds hidden attribution headers on the native OpenAI audio host", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      apiKey: "test-key",
      buffer: Buffer.from("audio"),
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
      fetchFn,
      fileName: "note.mp3",
      provider: "openai",
      timeoutMs: 1000,
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("originator")).toBe("openclaw");
    expect(headers.get("version")).toBeTruthy();
    expect(headers.get("user-agent")).toMatch(/^openclaw\//);
  });

  it("does not add hidden attribution headers on custom OpenAI-compatible hosts", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "ok" });

    await transcribeOpenAiCompatibleAudio({
      apiKey: "test-key",
      baseUrl: "https://proxy.example.com/v1",
      buffer: Buffer.from("audio"),
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
      fetchFn,
      fileName: "note.mp3",
      provider: "openai",
      timeoutMs: 1000,
    });

    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("originator")).toBeNull();
    expect(headers.get("version")).toBeNull();
    expect(headers.get("user-agent")).toBeNull();
  });
});
