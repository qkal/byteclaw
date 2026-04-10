import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  asFiniteNumber,
  asObjectRecord,
  resolveOpenAIProviderConfigRecord,
  trimToUndefined,
} from "./realtime-provider-shared.js";
import {
  DEFAULT_OPENAI_BASE_URL,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  isValidOpenAIModel,
  isValidOpenAIVoice,
  normalizeOpenAITtsBaseUrl,
  openaiTTS,
} from "./tts.js";

const OPENAI_SPEECH_RESPONSE_FORMATS = ["mp3", "opus", "wav"] as const;

type OpenAiSpeechResponseFormat = (typeof OPENAI_SPEECH_RESPONSE_FORMATS)[number];

interface OpenAITtsProviderConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  instructions?: string;
  responseFormat?: OpenAiSpeechResponseFormat;
}

interface OpenAITtsProviderOverrides {
  model?: string;
  voice?: string;
  speed?: number;
}

function normalizeOpenAISpeechResponseFormat(
  value: unknown,
): OpenAiSpeechResponseFormat | undefined {
  const next = normalizeOptionalLowercaseString(value);
  if (!next) {
    return undefined;
  }
  if (
    OPENAI_SPEECH_RESPONSE_FORMATS.includes(next as (typeof OPENAI_SPEECH_RESPONSE_FORMATS)[number])
  ) {
    return next as OpenAiSpeechResponseFormat;
  }
  throw new Error(`Invalid OpenAI speech responseFormat: ${next}`);
}

function isGroqSpeechBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    return hostname === "groq.com" || hostname.endsWith(".groq.com");
  } catch {
    return false;
  }
}

function resolveSpeechResponseFormat(
  baseUrl: string,
  target: "audio-file" | "voice-note",
  configuredFormat?: OpenAiSpeechResponseFormat,
): OpenAiSpeechResponseFormat {
  if (configuredFormat) {
    return configuredFormat;
  }
  if (isGroqSpeechBaseUrl(baseUrl)) {
    return "wav";
  }
  return target === "voice-note" ? "opus" : "mp3";
}

function responseFormatToFileExtension(
  format: OpenAiSpeechResponseFormat,
): ".mp3" | ".opus" | ".wav" {
  switch (format) {
    case "opus": {
      return ".opus";
    }
    case "wav": {
      return ".wav";
    }
    default: {
      return ".mp3";
    }
  }
}

function normalizeOpenAIProviderConfig(
  rawConfig: Record<string, unknown>,
): OpenAITtsProviderConfig {
  const raw = resolveOpenAIProviderConfigRecord(rawConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      path: "messages.tts.providers.openai.apiKey",
      value: raw?.apiKey,
    }),
    baseUrl: normalizeOpenAITtsBaseUrl(
      trimToUndefined(raw?.baseUrl) ??
        trimToUndefined(process.env.OPENAI_TTS_BASE_URL) ??
        DEFAULT_OPENAI_BASE_URL,
    ),
    instructions: trimToUndefined(raw?.instructions),
    model: trimToUndefined(raw?.model) ?? "gpt-4o-mini-tts",
    responseFormat: normalizeOpenAISpeechResponseFormat(raw?.responseFormat),
    speed: asFiniteNumber(raw?.speed),
    voice: trimToUndefined(raw?.voice) ?? "coral",
  };
}

function readOpenAIProviderConfig(config: SpeechProviderConfig): OpenAITtsProviderConfig {
  const normalized = normalizeOpenAIProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    instructions: trimToUndefined(config.instructions) ?? normalized.instructions,
    model: trimToUndefined(config.model) ?? normalized.model,
    responseFormat:
      normalizeOpenAISpeechResponseFormat(config.responseFormat) ?? normalized.responseFormat,
    speed: asFiniteNumber(config.speed) ?? normalized.speed,
    voice: trimToUndefined(config.voice) ?? normalized.voice,
  };
}

function readOpenAIOverrides(
  overrides: SpeechProviderOverrides | undefined,
): OpenAITtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: trimToUndefined(overrides.model),
    speed: asFiniteNumber(overrides.speed),
    voice: trimToUndefined(overrides.voice),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  const baseUrl = trimToUndefined(asObjectRecord(ctx.providerConfig)?.baseUrl);
  switch (ctx.key) {
    case "voice":
    case "openai_voice":
    case "openaivoice": {
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      if (!isValidOpenAIVoice(ctx.value, baseUrl)) {
        return { handled: true, warnings: [`invalid OpenAI voice "${ctx.value}"`] };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    }
    case "model":
    case "openai_model":
    case "openaimodel": {
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      if (!isValidOpenAIModel(ctx.value, baseUrl)) {
        return { handled: false };
      }
      return { handled: true, overrides: { model: ctx.value } };
    }
    default: {
      return { handled: false };
    }
  }
}

export function buildOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    autoSelectOrder: 10,
    id: "openai",
    isConfigured: ({ providerConfig }) =>
      Boolean(readOpenAIProviderConfig(providerConfig).apiKey || process.env.OPENAI_API_KEY),
    label: "OpenAI",
    listVoices: async () => OPENAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    models: OPENAI_TTS_MODELS,
    parseDirectiveToken,
    resolveConfig: ({ rawConfig }) => normalizeOpenAIProviderConfig(rawConfig),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeOpenAIProviderConfig(baseTtsConfig);
      const responseFormat = normalizeOpenAISpeechResponseFormat(talkProviderConfig.responseFormat);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                path: "talk.providers.openai.apiKey",
                value: talkProviderConfig.apiKey,
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: trimToUndefined(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asFiniteNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asFiniteNumber(talkProviderConfig.speed) }),
        ...(trimToUndefined(talkProviderConfig.instructions) == null
          ? {}
          : { instructions: trimToUndefined(talkProviderConfig.instructions) }),
        ...(responseFormat == null ? {} : { responseFormat }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: trimToUndefined(params.modelId) }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
    }),
    synthesize: async (req) => {
      const config = readOpenAIProviderConfig(req.providerConfig);
      const overrides = readOpenAIOverrides(req.providerOverrides);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const responseFormat = resolveSpeechResponseFormat(
        config.baseUrl,
        req.target,
        config.responseFormat,
      );
      const audioBuffer = await openaiTTS({
        apiKey,
        baseUrl: config.baseUrl,
        instructions: config.instructions,
        model: overrides.model ?? config.model,
        responseFormat,
        speed: overrides.speed ?? config.speed,
        text: req.text,
        timeoutMs: req.timeoutMs,
        voice: overrides.voice ?? config.voice,
      });
      return {
        audioBuffer,
        fileExtension: responseFormatToFileExtension(responseFormat),
        outputFormat: responseFormat,
        voiceCompatible: req.target === "voice-note" && responseFormat === "opus",
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readOpenAIProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const outputFormat = "pcm";
      const sampleRate = 24_000;
      const audioBuffer = await openaiTTS({
        apiKey,
        baseUrl: config.baseUrl,
        instructions: config.instructions,
        model: config.model,
        responseFormat: outputFormat,
        speed: config.speed,
        text: req.text,
        timeoutMs: req.timeoutMs,
        voice: config.voice,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
    voices: OPENAI_TTS_VOICES,
  };
}
