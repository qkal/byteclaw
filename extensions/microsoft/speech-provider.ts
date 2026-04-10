import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  CHROMIUM_FULL_VERSION,
  TRUSTED_CLIENT_TOKEN,
  generateSecMsGecToken,
} from "node-edge-tts/dist/drm.js";
import { isVoiceCompatibleAudio } from "openclaw/plugin-sdk/media-runtime";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import { asBoolean, asFiniteNumber, asObject, trimToUndefined } from "openclaw/plugin-sdk/speech";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { edgeTTS, inferEdgeExtension } from "./tts.js";

const DEFAULT_EDGE_VOICE = "en-US-MichelleNeural";
const DEFAULT_EDGE_LANG = "en-US";
const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

interface MicrosoftProviderConfig {
  enabled: boolean;
  voice: string;
  lang: string;
  outputFormat: string;
  outputFormatConfigured: boolean;
  pitch?: string;
  rate?: string;
  volume?: string;
  saveSubtitles: boolean;
  proxy?: string;
  timeoutMs?: number;
}

interface MicrosoftVoiceListEntry {
  ShortName?: string;
  FriendlyName?: string;
  Locale?: string;
  Gender?: string;
  VoiceTag?: {
    ContentCategories?: string[];
    VoicePersonalities?: string[];
  };
}

function normalizeMicrosoftProviderConfig(
  rawConfig: Record<string, unknown>,
): MicrosoftProviderConfig {
  const providers = asObject(rawConfig.providers);
  const rawEdge = asObject(rawConfig.edge);
  const rawMicrosoft = asObject(rawConfig.microsoft);
  const rawProvider = asObject(providers?.microsoft);
  const raw = { ...rawEdge, ...rawMicrosoft, ...rawProvider };
  const outputFormat = trimToUndefined(raw.outputFormat);
  return {
    enabled: asBoolean(raw.enabled) ?? true,
    lang: trimToUndefined(raw.lang) ?? DEFAULT_EDGE_LANG,
    outputFormat: outputFormat ?? DEFAULT_EDGE_OUTPUT_FORMAT,
    outputFormatConfigured: Boolean(outputFormat),
    pitch: trimToUndefined(raw.pitch),
    proxy: trimToUndefined(raw.proxy),
    rate: trimToUndefined(raw.rate),
    saveSubtitles: asBoolean(raw.saveSubtitles) ?? false,
    timeoutMs: asFiniteNumber(raw.timeoutMs),
    voice: trimToUndefined(raw.voice) ?? DEFAULT_EDGE_VOICE,
    volume: trimToUndefined(raw.volume),
  };
}

function readMicrosoftProviderConfig(config: SpeechProviderConfig): MicrosoftProviderConfig {
  const defaults = normalizeMicrosoftProviderConfig({});
  return {
    enabled: asBoolean(config.enabled) ?? defaults.enabled,
    lang: trimToUndefined(config.lang) ?? defaults.lang,
    outputFormat: trimToUndefined(config.outputFormat) ?? defaults.outputFormat,
    outputFormatConfigured:
      asBoolean(config.outputFormatConfigured) ?? defaults.outputFormatConfigured,
    pitch: trimToUndefined(config.pitch) ?? defaults.pitch,
    proxy: trimToUndefined(config.proxy) ?? defaults.proxy,
    rate: trimToUndefined(config.rate) ?? defaults.rate,
    saveSubtitles: asBoolean(config.saveSubtitles) ?? defaults.saveSubtitles,
    timeoutMs: asFiniteNumber(config.timeoutMs) ?? defaults.timeoutMs,
    voice: trimToUndefined(config.voice) ?? defaults.voice,
    volume: trimToUndefined(config.volume) ?? defaults.volume,
  };
}

function buildMicrosoftVoiceHeaders(): Record<string, string> {
  const major = CHROMIUM_FULL_VERSION.split(".")[0] || "0";
  return {
    Accept: "*/*",
    Authority: "speech.platform.bing.com",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Sec-MS-GEC": generateSecMsGecToken(),
    "Sec-MS-GEC-Version": `1-${CHROMIUM_FULL_VERSION}`,
    "User-Agent":
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
  };
}

function formatMicrosoftVoiceDescription(entry: MicrosoftVoiceListEntry): string | undefined {
  const personalities = entry.VoiceTag?.VoicePersonalities?.filter(Boolean) ?? [];
  return personalities.length > 0 ? personalities.join(", ") : undefined;
}

export function isCjkDominant(text: string): boolean {
  const stripped = text.replace(/\s+/g, "");
  if (stripped.length === 0) {
    return false;
  }
  let cjkCount = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e_00 && code <= 0x9f_ff) ||
      (code >= 0x34_00 && code <= 0x4d_bf) ||
      (code >= 0x30_00 && code <= 0x30_3f) ||
      (code >= 0xff_00 && code <= 0xff_ef)
    ) {
      cjkCount += 1;
    }
  }
  return cjkCount / stripped.length > 0.3;
}

const DEFAULT_CHINESE_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_CHINESE_EDGE_LANG = "zh-CN";

export async function listMicrosoftVoices(): Promise<SpeechVoiceOption[]> {
  const response = await fetch(
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
      `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
    {
      headers: buildMicrosoftVoiceHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`Microsoft voices API error (${response.status})`);
  }
  const voices = (await response.json()) as MicrosoftVoiceListEntry[];
  return Array.isArray(voices)
    ? voices
        .map((voice) => ({
          category: voice.VoiceTag?.ContentCategories?.find((value) => value.trim().length > 0),
          description: formatMicrosoftVoiceDescription(voice),
          gender: trimToUndefined(voice.Gender),
          id: voice.ShortName?.trim() ?? "",
          locale: trimToUndefined(voice.Locale),
          name: trimToUndefined(voice.FriendlyName) ?? trimToUndefined(voice.ShortName),
          personalities: voice.VoiceTag?.VoicePersonalities?.filter(
            (value): value is string => value.trim().length > 0,
          ),
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export function buildMicrosoftSpeechProvider(): SpeechProviderPlugin {
  return {
    aliases: ["edge"],
    autoSelectOrder: 30,
    id: "microsoft",
    isConfigured: ({ providerConfig }) => readMicrosoftProviderConfig(providerConfig).enabled,
    label: "Microsoft",
    listVoices: async () => await listMicrosoftVoices(),
    resolveConfig: ({ rawConfig }) => normalizeMicrosoftProviderConfig(rawConfig),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeMicrosoftProviderConfig(baseTtsConfig);
      return {
        ...base,
        enabled: true,
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voice: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.languageCode) == null
          ? {}
          : { lang: trimToUndefined(talkProviderConfig.languageCode) }),
        ...(trimToUndefined(talkProviderConfig.outputFormat) == null
          ? {}
          : { outputFormat: trimToUndefined(talkProviderConfig.outputFormat) }),
        ...(trimToUndefined(talkProviderConfig.pitch) == null
          ? {}
          : { pitch: trimToUndefined(talkProviderConfig.pitch) }),
        ...(trimToUndefined(talkProviderConfig.rate) == null
          ? {}
          : { rate: trimToUndefined(talkProviderConfig.rate) }),
        ...(trimToUndefined(talkProviderConfig.volume) == null
          ? {}
          : { volume: trimToUndefined(talkProviderConfig.volume) }),
        ...(trimToUndefined(talkProviderConfig.proxy) == null
          ? {}
          : { proxy: trimToUndefined(talkProviderConfig.proxy) }),
        ...(asFiniteNumber(talkProviderConfig.timeoutMs) == null
          ? {}
          : { timeoutMs: asFiniteNumber(talkProviderConfig.timeoutMs) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voice: trimToUndefined(params.voiceId) }),
      ...(trimToUndefined(params.outputFormat) == null
        ? {}
        : { outputFormat: trimToUndefined(params.outputFormat) }),
    }),
    synthesize: async (req) => {
      const config = readMicrosoftProviderConfig(req.providerConfig);
      const tempRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tempRoot, { mode: 0o700, recursive: true });
      const tempDir = mkdtempSync(path.join(tempRoot, "tts-microsoft-"));
      const overrideVoice = trimToUndefined(req.providerOverrides?.voice);
      let voice = overrideVoice ?? config.voice;
      let { lang } = config;
      let outputFormat =
        trimToUndefined(req.providerOverrides?.outputFormat) ?? config.outputFormat;
      const fallbackOutputFormat =
        outputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

      if (!overrideVoice && voice === DEFAULT_EDGE_VOICE && isCjkDominant(req.text)) {
        voice = DEFAULT_CHINESE_EDGE_VOICE;
        lang = DEFAULT_CHINESE_EDGE_LANG;
      }

      try {
        const runEdge = async (format: string) => {
          const fileExtension = inferEdgeExtension(format);
          const outputPath = path.join(tempDir, `speech${fileExtension}`);
          await edgeTTS({
            config: {
              ...config,
              lang,
              outputFormat: format,
              voice,
            },
            outputPath,
            text: req.text,
            timeoutMs: req.timeoutMs,
          });
          const audioBuffer = readFileSync(outputPath);
          return {
            audioBuffer,
            fileExtension,
            outputFormat: format,
            voiceCompatible: isVoiceCompatibleAudio({ fileName: outputPath }),
          };
        };

        try {
          return await runEdge(outputFormat);
        } catch (error) {
          if (!fallbackOutputFormat || fallbackOutputFormat === outputFormat) {
            throw error;
          }
          outputFormat = fallbackOutputFormat;
          return await runEdge(outputFormat);
        }
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  };
}
