import type { SpeechProviderPlugin } from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  TALK_TEST_PROVIDER_ID,
  TALK_TEST_PROVIDER_LABEL,
} from "../test-utils/talk-test-provider.js";

interface StubSpeechProviderOptions {
  id: SpeechProviderPlugin["id"];
  label: string;
  aliases?: string[];
  voices?: string[];
  resolveTalkOverrides?: SpeechProviderPlugin["resolveTalkOverrides"];
  synthesize?: SpeechProviderPlugin["synthesize"];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchStubSpeechAudio(
  url: string,
  init: RequestInit,
  providerId: string,
): Promise<Buffer> {
  const withTimeout = async <T>(label: string, run: Promise<T>): Promise<T> =>
    await Promise.race([
      run,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${providerId} stub ${label} timed out`)), 5000),
      ),
    ]);
  const response = await withTimeout("fetch", globalThis.fetch(url, init));
  const arrayBuffer = await withTimeout("read", response.arrayBuffer());
  return Buffer.from(arrayBuffer);
}

const createStubSpeechProvider = (params: StubSpeechProviderOptions): SpeechProviderPlugin => ({
  aliases: params.aliases,
  id: params.id,
  isConfigured: () => true,
  label: params.label,
  listVoices: async () =>
    (params.voices ?? []).map((voiceId) => ({
      id: voiceId,
      name: voiceId,
    })),
  resolveTalkOverrides: params.resolveTalkOverrides,
  synthesize:
    params.synthesize ??
    (async () => ({
      audioBuffer: Buffer.from(`${params.id}-audio`, "utf8"),
      fileExtension: ".mp3",
      outputFormat: "mp3",
      voiceCompatible: true,
    })),
  voices: params.voices,
});

export function createDefaultGatewayTestSpeechProviders() {
  return [
    {
      pluginId: "openai",
      provider: createStubSpeechProvider({
        id: "openai",
        label: "OpenAI",
        resolveTalkOverrides: ({ params }) => ({
          ...(normalizeOptionalString(params.voiceId) == null
            ? {}
            : { voice: normalizeOptionalString(params.voiceId) }),
          ...(normalizeOptionalString(params.modelId) == null
            ? {}
            : { model: normalizeOptionalString(params.modelId) }),
          ...(asNumber(params.speed) == null ? {} : { speed: asNumber(params.speed) }),
        }),
        synthesize: async (req) => {
          const config = req.providerConfig as Record<string, unknown>;
          const overrides = (req.providerOverrides ?? {}) as Record<string, unknown>;
          const body = JSON.stringify({
            input: req.text,
            model:
              normalizeOptionalString(overrides.model) ??
              normalizeOptionalString(config.modelId) ??
              "gpt-4o-mini-tts",
            voice:
              normalizeOptionalString(overrides.voice) ??
              normalizeOptionalString(config.voiceId) ??
              "alloy",
            ...(asNumber(overrides.speed) == null ? {} : { speed: asNumber(overrides.speed) }),
          });
          const audioBuffer = await fetchStubSpeechAudio(
            "https://api.openai.com/v1/audio/speech",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            },
            "openai",
          );
          return {
            audioBuffer,
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: false,
          };
        },
        voices: ["alloy", "nova"],
      }),
      source: "test" as const,
    },
    {
      pluginId: TALK_TEST_PROVIDER_ID,
      provider: createStubSpeechProvider({
        id: TALK_TEST_PROVIDER_ID,
        label: TALK_TEST_PROVIDER_LABEL,
        resolveTalkOverrides: ({ params }) => ({
          ...(normalizeOptionalString(params.voiceId) == null
            ? {}
            : { voiceId: normalizeOptionalString(params.voiceId) }),
          ...(normalizeOptionalString(params.modelId) == null
            ? {}
            : { modelId: normalizeOptionalString(params.modelId) }),
          ...(normalizeOptionalString(params.outputFormat) == null
            ? {}
            : { outputFormat: normalizeOptionalString(params.outputFormat) }),
          ...(asNumber(params.latencyTier) == null
            ? {}
            : { latencyTier: asNumber(params.latencyTier) }),
        }),
        voices: ["stub-default-voice", "stub-alt-voice"],
      }),
      source: "test" as const,
    },
  ];
}
