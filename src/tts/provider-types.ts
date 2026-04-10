import type { OpenClawConfig } from "../config/config.js";
import type { TalkProviderConfig } from "../config/types.gateway.js";

export type SpeechProviderId = string;

export type SpeechSynthesisTarget = "audio-file" | "voice-note";

export type SpeechProviderConfig = Record<string, unknown>;

export type SpeechProviderOverrides = Record<string, unknown>;

export interface SpeechModelOverridePolicy {
  enabled: boolean;
  allowText: boolean;
  allowProvider: boolean;
  allowVoice: boolean;
  allowModelId: boolean;
  allowVoiceSettings: boolean;
  allowNormalization: boolean;
  allowSeed: boolean;
}

export interface TtsDirectiveOverrides {
  ttsText?: string;
  provider?: SpeechProviderId;
  providerOverrides?: Record<string, SpeechProviderOverrides>;
}

export interface TtsDirectiveParseResult {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
}

export interface SpeechProviderConfiguredContext {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  timeoutMs: number;
}

export interface SpeechSynthesisRequest {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  target: SpeechSynthesisTarget;
  providerOverrides?: SpeechProviderOverrides;
  timeoutMs: number;
}

export interface SpeechSynthesisResult {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
}

export interface SpeechTelephonySynthesisRequest {
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  timeoutMs: number;
}

export interface SpeechTelephonySynthesisResult {
  audioBuffer: Buffer;
  outputFormat: string;
  sampleRate: number;
}

export interface SpeechVoiceOption {
  id: string;
  name?: string;
  category?: string;
  description?: string;
  locale?: string;
  gender?: string;
  personalities?: string[];
}

export interface SpeechListVoicesRequest {
  cfg?: OpenClawConfig;
  providerConfig?: SpeechProviderConfig;
  apiKey?: string;
  baseUrl?: string;
}

export interface SpeechProviderResolveConfigContext {
  cfg: OpenClawConfig;
  rawConfig: Record<string, unknown>;
  timeoutMs: number;
}

export interface SpeechDirectiveTokenParseContext {
  key: string;
  value: string;
  policy: SpeechModelOverridePolicy;
  providerConfig?: SpeechProviderConfig;
  currentOverrides?: SpeechProviderOverrides;
}

export interface SpeechDirectiveTokenParseResult {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
}

export interface SpeechProviderResolveTalkConfigContext {
  cfg: OpenClawConfig;
  baseTtsConfig: Record<string, unknown>;
  talkProviderConfig: TalkProviderConfig;
  timeoutMs: number;
}

export interface SpeechProviderResolveTalkOverridesContext {
  talkProviderConfig: TalkProviderConfig;
  params: Record<string, unknown>;
}
