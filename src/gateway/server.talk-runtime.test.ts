import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TalkSpeakTestPayload,
  invokeTalkSpeakDirect,
  withSpeechProviders,
} from "./talk.test-helpers.js";

const synthesizeSpeechMock = vi.hoisted(() =>
  vi.fn<typeof import("../tts/tts.js").synthesizeSpeech>(async () => ({
    audioBuffer: Buffer.from([7, 8, 9]),
    fileExtension: ".mp3",
    outputFormat: "mp3",
    provider: "acme",
    success: true,
    voiceCompatible: false,
  })),
);

vi.mock("../tts/tts.js", () => ({
  synthesizeSpeech: synthesizeSpeechMock,
}));

type SpeechProvider = Parameters<typeof withSpeechProviders>[0][number]["provider"];

const ALIAS_STUB_VOICE_ID = "VoiceAlias1234567890";

async function writeAcmeTalkConfig() {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    talk: {
      provider: "acme",
      providers: {
        acme: {
          voiceId: "plugin-voice",
        },
      },
    },
  });
}

async function withAcmeSpeechProvider(
  synthesize: SpeechProvider["synthesize"],
  run: () => Promise<void>,
) {
  await withSpeechProviders(
    [
      {
        pluginId: "acme-plugin",
        provider: {
          id: "acme",
          isConfigured: () => true,
          label: "Acme Speech",
          synthesize,
        },
        source: "test",
      },
    ],
    run,
  );
}

describe("gateway talk runtime", () => {
  beforeEach(() => {
    synthesizeSpeechMock.mockReset();
    synthesizeSpeechMock.mockResolvedValue({
      audioBuffer: Buffer.from([7, 8, 9]),
      fileExtension: ".mp3",
      outputFormat: "mp3",
      provider: "acme",
      success: true,
      voiceCompatible: false,
    });
  });

  it("allows extension speech providers through the talk setup", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "acme",
        providers: {
          acme: {
            voiceId: "plugin-voice",
          },
        },
      },
    });

    await withSpeechProviders(
      [
        {
          pluginId: "acme-plugin",
          provider: {
            id: "acme",
            isConfigured: () => true,
            label: "Acme Speech",
            resolveTalkConfig: ({ talkProviderConfig }) => ({
              ...talkProviderConfig,
              resolvedBy: "acme-test-provider",
            }),
            synthesize: async () => {
              throw new Error("synthesize should be mocked at the handler boundary");
            },
          },
          source: "test",
        },
      ],
      async () => {
        const res = await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
        });
        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect(synthesizeSpeechMock).toHaveBeenCalledWith(
          expect.objectContaining({
            cfg: expect.objectContaining({
              messages: expect.objectContaining({
                tts: expect.objectContaining({
                  provider: "acme",
                  providers: expect.objectContaining({
                    acme: expect.objectContaining({
                      resolvedBy: "acme-test-provider",
                      voiceId: "plugin-voice",
                    }),
                  }),
                }),
              }),
            }),
            disableFallback: true,
            overrides: { provider: "acme" },
            text: "Hello from talk mode.",
          }),
        );
      },
    );
  });

  it("allows extension speech providers through talk.speak", async () => {
    await writeAcmeTalkConfig();

    await withAcmeSpeechProvider(
      async () => ({
        audioBuffer: Buffer.from([7, 8, 9]),
        fileExtension: ".mp3",
        outputFormat: "mp3",
        voiceCompatible: false,
      }),
      async () => {
        const res = await invokeTalkSpeakDirect({
          text: "Hello from talk mode.",
        });
        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.provider).toBe("acme");
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.audioBase64).toBe(
          Buffer.from([7, 8, 9]).toString("base64"),
        );
      },
    );
  });

  it("resolves talk voice aliases case-insensitively and forwards provider overrides", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            voiceAliases: {
              Clawd: ALIAS_STUB_VOICE_ID,
            },
            voiceId: "stub-default-voice",
          },
        },
      },
    });

    await withSpeechProviders(
      [
        {
          pluginId: "elevenlabs-test",
          provider: {
            id: "elevenlabs",
            isConfigured: () => true,
            label: "ElevenLabs",
            resolveTalkOverrides: ({ params }) => ({
              ...(typeof params.voiceId === "string" && params.voiceId.trim().length > 0
                ? { voiceId: params.voiceId.trim() }
                : {}),
              ...(typeof params.outputFormat === "string" && params.outputFormat.trim().length > 0
                ? { outputFormat: params.outputFormat.trim() }
                : {}),
              ...(typeof params.latencyTier === "number"
                ? { latencyTier: params.latencyTier }
                : {}),
            }),
            synthesize: async () => {
              throw new Error("synthesize should be mocked at the handler boundary");
            },
          },
          source: "test",
        },
      ],
      async () => {
        synthesizeSpeechMock.mockResolvedValue({
          audioBuffer: Buffer.from([4, 5, 6]),
          fileExtension: ".pcm",
          outputFormat: "pcm_44100",
          provider: "elevenlabs",
          success: true,
          voiceCompatible: false,
        });

        const res = await invokeTalkSpeakDirect({
          latencyTier: 3,
          outputFormat: "pcm_44100",
          text: "Hello from talk mode.",
          voiceId: "clawd",
        });

        expect(res?.ok, JSON.stringify(res?.error)).toBe(true);
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.provider).toBe("elevenlabs");
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.outputFormat).toBe("pcm_44100");
        expect((res?.payload as TalkSpeakTestPayload | undefined)?.audioBase64).toBe(
          Buffer.from([4, 5, 6]).toString("base64"),
        );
        expect(synthesizeSpeechMock).toHaveBeenCalledWith(
          expect.objectContaining({
            disableFallback: true,
            overrides: {
              provider: "elevenlabs",
              providerOverrides: {
                elevenlabs: {
                  latencyTier: 3,
                  outputFormat: "pcm_44100",
                  voiceId: ALIAS_STUB_VOICE_ID,
                },
              },
            },
            text: "Hello from talk mode.",
          }),
        );
      },
    );
  });

  it("returns fallback-eligible details when talk provider is not configured", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({ talk: {} });

    const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
    expect(res?.ok).toBe(false);
    expect(res?.error?.message).toContain("talk provider not configured");
    expect((res?.error as { details?: unknown } | undefined)?.details).toEqual({
      fallbackEligible: true,
      reason: "talk_unconfigured",
    });
  });

  it("returns synthesis_failed details when the provider rejects synthesis", async () => {
    await writeAcmeTalkConfig();

    await withAcmeSpeechProvider(
      async () => ({}) as never,
      async () => {
        synthesizeSpeechMock.mockResolvedValue({
          error: "provider failed",
          success: false,
        });
        const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
        expect(res?.ok).toBe(false);
        expect(res?.error?.details).toEqual({
          fallbackEligible: false,
          reason: "synthesis_failed",
        });
      },
    );
  });

  it("rejects empty audio results as invalid_audio_result", async () => {
    await writeAcmeTalkConfig();

    await withAcmeSpeechProvider(
      async () => ({}) as never,
      async () => {
        synthesizeSpeechMock.mockResolvedValue({
          audioBuffer: Buffer.alloc(0),
          fileExtension: ".mp3",
          outputFormat: "mp3",
          provider: "acme",
          success: true,
          voiceCompatible: false,
        });
        const res = await invokeTalkSpeakDirect({ text: "Hello from talk mode." });
        expect(res?.ok).toBe(false);
        expect(res?.error?.details).toEqual({
          fallbackEligible: false,
          reason: "invalid_audio_result",
        });
      },
    );
  });
});
