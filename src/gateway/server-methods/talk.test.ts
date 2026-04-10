import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { talkHandlers } from "./talk.js";

const mocks = vi.hoisted(() => ({
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  loadConfig: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshot: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
}));

vi.mock("../../tts/tts.js", () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

function createTalkConfig(apiKey: unknown): OpenClawConfig {
  return {
    talk: {
      provider: "acme",
      providers: {
        acme: {
          apiKey,
          voiceId: "stub-default-voice",
        },
      },
    },
  } as OpenClawConfig;
}

describe("talk.speak handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the active runtime config snapshot instead of the raw config snapshot", async () => {
    const runtimeConfig = createTalkConfig("env-acme-key");
    const diskConfig = createTalkConfig({
      id: "ACME_SPEECH_API_KEY",
      provider: "default",
      source: "env",
    });

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      config: diskConfig,
      hash: "test-hash",
      path: "/tmp/openclaw.json",
      valid: true,
    });
    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Speech",
      resolveTalkConfig: ({
        talkProviderConfig,
      }: {
        talkProviderConfig: Record<string, unknown>;
      }) => talkProviderConfig,
    });
    mocks.synthesizeSpeech.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig; text: string; disableFallback: boolean }) => {
        expect(cfg.messages?.tts?.provider).toBe("acme");
        expect(cfg.messages?.tts?.providers?.acme?.apiKey).toBe("env-acme-key");
        return {
          audioBuffer: Buffer.from([1, 2, 3]),
          fileExtension: ".mp3",
          outputFormat: "mp3",
          provider: "acme",
          success: true,
          voiceCompatible: false,
        };
      },
    );

    const respond = vi.fn();
    await talkHandlers["talk.speak"]({
      client: null,
      context: {} as never,
      isWebchatConnect: () => false,
      params: { text: "Hello from talk mode." },
      req: { id: "1", method: "talk.speak", type: "req" },
      respond: respond as never,
    });

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        disableFallback: true,
        text: "Hello from talk mode.",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        fileExtension: ".mp3",
        mimeType: "audio/mpeg",
        outputFormat: "mp3",
        provider: "acme",
      }),
      undefined,
    );
  });
});
