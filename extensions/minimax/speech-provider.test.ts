import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMinimaxSpeechProvider } from "./speech-provider.js";

describe("buildMinimaxSpeechProvider", () => {
  const provider = buildMinimaxSpeechProvider();

  describe("metadata", () => {
    it("has correct id and label", () => {
      expect(provider.id).toBe("minimax");
      expect(provider.label).toBe("MiniMax");
    });

    it("has autoSelectOrder 40", () => {
      expect(provider.autoSelectOrder).toBe(40);
    });

    it("exposes models and voices", () => {
      expect(provider.models).toContain("speech-2.8-hd");
      expect(provider.voices).toContain("English_expressive_narrator");
    });
  });

  describe("isConfigured", () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it("returns true when apiKey is in provider config", () => {
      expect(
        provider.isConfigured({ providerConfig: { apiKey: "sk-test" }, timeoutMs: 30_000 }),
      ).toBe(true);
    });

    it("returns false when no apiKey anywhere", () => {
      delete process.env.MINIMAX_API_KEY;
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30_000 })).toBe(false);
    });

    it("returns true when MINIMAX_API_KEY env var is set", () => {
      process.env.MINIMAX_API_KEY = "sk-env";
      expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 30_000 })).toBe(true);
    });
  });

  describe("resolveConfig", () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it("returns defaults when rawConfig is empty", () => {
      delete process.env.MINIMAX_API_HOST;
      delete process.env.MINIMAX_TTS_MODEL;
      delete process.env.MINIMAX_TTS_VOICE_ID;
      const config = provider.resolveConfig!({
        cfg: {} as never,
        rawConfig: {},
        timeoutMs: 30_000,
      });
      expect(config.baseUrl).toBe("https://api.minimax.io");
      expect(config.model).toBe("speech-2.8-hd");
      expect(config.voiceId).toBe("English_expressive_narrator");
    });

    it("reads from providers.minimax in rawConfig", () => {
      const config = provider.resolveConfig!({
        cfg: {} as never,
        rawConfig: {
          providers: {
            minimax: {
              baseUrl: "https://custom.api.com",
              model: "speech-01-240228",
              pitch: 3,
              speed: 1.5,
              voiceId: "Chinese (Mandarin)_Warm_Girl",
              vol: 2,
            },
          },
        },
        timeoutMs: 30_000,
      });
      expect(config.baseUrl).toBe("https://custom.api.com");
      expect(config.model).toBe("speech-01-240228");
      expect(config.voiceId).toBe("Chinese (Mandarin)_Warm_Girl");
      expect(config.speed).toBe(1.5);
      expect(config.vol).toBe(2);
      expect(config.pitch).toBe(3);
    });

    it("reads from env vars as fallback", () => {
      process.env.MINIMAX_API_HOST = "https://env.api.com";
      process.env.MINIMAX_TTS_MODEL = "speech-01-240228";
      process.env.MINIMAX_TTS_VOICE_ID = "Chinese (Mandarin)_Gentle_Boy";
      const config = provider.resolveConfig!({
        cfg: {} as never,
        rawConfig: {},
        timeoutMs: 30_000,
      });
      expect(config.baseUrl).toBe("https://env.api.com");
      expect(config.model).toBe("speech-01-240228");
      expect(config.voiceId).toBe("Chinese (Mandarin)_Gentle_Boy");
    });
  });

  describe("parseDirectiveToken", () => {
    const policy = {
      allowModelId: true,
      allowNormalization: true,
      allowProvider: true,
      allowSeed: true,
      allowText: true,
      allowVoice: true,
      allowVoiceSettings: true,
      enabled: true,
    };

    it("handles voice key", () => {
      const result = provider.parseDirectiveToken!({
        key: "voice",
        policy,
        value: "Chinese (Mandarin)_Warm_Girl",
      });
      expect(result.handled).toBe(true);
      expect(result.overrides?.voiceId).toBe("Chinese (Mandarin)_Warm_Girl");
    });

    it("handles voiceid key", () => {
      const result = provider.parseDirectiveToken!({ key: "voiceid", policy, value: "test_voice" });
      expect(result.handled).toBe(true);
      expect(result.overrides?.voiceId).toBe("test_voice");
    });

    it("handles model key", () => {
      const result = provider.parseDirectiveToken!({
        key: "model",
        policy,
        value: "speech-01-240228",
      });
      expect(result.handled).toBe(true);
      expect(result.overrides?.model).toBe("speech-01-240228");
    });

    it("handles speed key with valid value", () => {
      const result = provider.parseDirectiveToken!({ key: "speed", policy, value: "1.5" });
      expect(result.handled).toBe(true);
      expect(result.overrides?.speed).toBe(1.5);
    });

    it("warns on invalid speed", () => {
      const result = provider.parseDirectiveToken!({ key: "speed", policy, value: "5.0" });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.overrides).toBeUndefined();
    });

    it("handles vol key", () => {
      const result = provider.parseDirectiveToken!({ key: "vol", policy, value: "3" });
      expect(result.handled).toBe(true);
      expect(result.overrides?.vol).toBe(3);
    });

    it("warns on vol=0 (exclusive minimum)", () => {
      const result = provider.parseDirectiveToken!({ key: "vol", policy, value: "0" });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it("handles volume alias", () => {
      const result = provider.parseDirectiveToken!({ key: "volume", policy, value: "5" });
      expect(result.handled).toBe(true);
      expect(result.overrides?.vol).toBe(5);
    });

    it("handles pitch key", () => {
      const result = provider.parseDirectiveToken!({ key: "pitch", policy, value: "-3" });
      expect(result.handled).toBe(true);
      expect(result.overrides?.pitch).toBe(-3);
    });

    it("warns on out-of-range pitch", () => {
      const result = provider.parseDirectiveToken!({ key: "pitch", policy, value: "20" });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it("returns handled=false for unknown keys", () => {
      const result = provider.parseDirectiveToken!({
        key: "unknown_key",
        policy,
        value: "whatever",
      });
      expect(result.handled).toBe(false);
    });

    it("suppresses voice when policy disallows it", () => {
      const result = provider.parseDirectiveToken!({
        key: "voice",
        policy: { ...policy, allowVoice: false },
        value: "test",
      });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });

    it("suppresses model when policy disallows it", () => {
      const result = provider.parseDirectiveToken!({
        key: "model",
        policy: { ...policy, allowModelId: false },
        value: "test",
      });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });
  });

  describe("synthesize", () => {
    const savedFetch = globalThis.fetch;

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      globalThis.fetch = savedFetch;
      vi.restoreAllMocks();
    });

    it("makes correct API call and decodes hex response", async () => {
      const hexAudio = Buffer.from("fake-audio-data").toString("hex");
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { audio: hexAudio } }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );

      const result = await provider.synthesize({
        cfg: {} as never,
        providerConfig: { apiKey: "sk-test", baseUrl: "https://api.minimaxi.com" },
        target: "audio-file",
        text: "Hello world",
        timeoutMs: 30_000,
      });

      expect(result.outputFormat).toBe("mp3");
      expect(result.fileExtension).toBe(".mp3");
      expect(result.voiceCompatible).toBe(false);
      expect(result.audioBuffer.toString()).toBe("fake-audio-data");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.minimaxi.com/v1/t2a_v2");
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("speech-2.8-hd");
      expect(body.text).toBe("Hello world");
      expect(body.voice_setting.voice_id).toBe("English_expressive_narrator");
    });

    it("applies overrides", async () => {
      const hexAudio = Buffer.from("audio").toString("hex");
      const mockFetch = vi.mocked(globalThis.fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { audio: hexAudio } }), { status: 200 }),
      );

      await provider.synthesize({
        cfg: {} as never,
        providerConfig: { apiKey: "sk-test" },
        providerOverrides: { model: "speech-01-240228", speed: 1.5, voiceId: "custom_voice" },
        target: "audio-file",
        text: "Test",
        timeoutMs: 30_000,
      });

      const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
      expect(body.model).toBe("speech-01-240228");
      expect(body.voice_setting.voice_id).toBe("custom_voice");
      expect(body.voice_setting.speed).toBe(1.5);
    });

    it("throws when API key is missing", async () => {
      const savedKey = process.env.MINIMAX_API_KEY;
      delete process.env.MINIMAX_API_KEY;
      try {
        await expect(
          provider.synthesize({
            cfg: {} as never,
            providerConfig: {},
            target: "audio-file",
            text: "Test",
            timeoutMs: 30_000,
          }),
        ).rejects.toThrow("MiniMax API key missing");
      } finally {
        if (savedKey) {
          process.env.MINIMAX_API_KEY = savedKey;
        }
      }
    });

    it("throws on API error with response body", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );
      await expect(
        provider.synthesize({
          cfg: {} as never,
          providerConfig: { apiKey: "sk-test" },
          target: "audio-file",
          text: "Test",
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("MiniMax TTS API error (401): Unauthorized");
    });
  });

  describe("listVoices", () => {
    it("returns known voices", async () => {
      const voices = await provider.listVoices!({} as never);
      expect(voices.length).toBeGreaterThan(0);
      expect(voices[0].id).toBe("English_expressive_narrator");
    });
  });
});
