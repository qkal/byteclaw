import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

describe("buildOpenAISpeechProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes provider-owned speech config from raw provider config", () => {
    const provider = buildOpenAISpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test",
            baseUrl: "https://example.com/v1/",
            instructions: " Speak warmly ",
            model: "tts-1",
            responseFormat: " WAV ",
            speed: 1.25,
            voice: "alloy",
          },
        },
      },
      timeoutMs: 30_000,
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://example.com/v1",
      instructions: "Speak warmly",
      model: "tts-1",
      responseFormat: "wav",
      speed: 1.25,
      voice: "alloy",
    });
  });

  it("parses OpenAI directive tokens against the resolved base url", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.parseDirectiveToken?.({
        key: "voice",
        policy: {
          allowModelId: true,
          allowVoice: true,
        },
        providerConfig: {
          baseUrl: "https://api.openai.com/v1/",
        },
        value: "alloy",
      } as never),
    ).toEqual({
      handled: true,
      overrides: { voice: "alloy" },
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "model",
        policy: {
          allowModelId: true,
          allowVoice: true,
        },
        providerConfig: {
          baseUrl: "https://api.openai.com/v1/",
        },
        value: "kokoro-custom-model",
      } as never),
    ).toEqual({
      handled: false,
    });
  });

  it("preserves talk responseFormat overrides", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.resolveTalkConfig?.({
        baseTtsConfig: {
          providers: {
            openai: {
              apiKey: "sk-base",
              responseFormat: "mp3",
            },
          },
        },
        cfg: {} as never,
        talkProviderConfig: {
          apiKey: "sk-talk",
          responseFormat: " WAV ",
        },
        timeoutMs: 30_000,
      }),
    ).toMatchObject({
      apiKey: "sk-talk",
      responseFormat: "wav",
    });
  });

  it("maps Talk speak params onto OpenAI speech overrides", () => {
    const provider = buildOpenAISpeechProvider();

    expect(
      provider.resolveTalkOverrides?.({
        params: {
          modelId: "tts-1",
          speed: 218 / 175,
          text: "Hello from talk mode.",
          voiceId: "nova",
        },
        talkProviderConfig: {},
      }),
    ).toEqual({
      model: "tts-1",
      speed: 218 / 175,
      voice: "nova",
    });
  });

  it("uses wav for Groq-compatible OpenAI TTS endpoints", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeTruthy();
      const body = JSON.parse(String(init?.body)) as { response_format?: string };
      expect(body.response_format).toBe("wav");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize({
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "canopylabs/orpheus-v1-english",
        voice: "daniel",
      },
      target: "audio-file",
      text: "hello",
      timeoutMs: 1000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
  });

  it("honors explicit responseFormat overrides and clears voice-note compatibility when not opus", async () => {
    const provider = buildOpenAISpeechProvider();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeTruthy();
      const body = JSON.parse(String(init?.body)) as { response_format?: string };
      expect(body.response_format).toBe("wav");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize({
      cfg: {} as never,
      providerConfig: {
        apiKey: "sk-test",
        baseUrl: "https://proxy.example.com/openai/v1",
        model: "canopylabs/orpheus-v1-english",
        responseFormat: "wav",
        voice: "daniel",
      },
      target: "voice-note",
      text: "hello",
      timeoutMs: 1000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
  });
});
