import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaNormalizationEntry } from "../media-generation/runtime-shared.js";

export type MusicGenerationOutputFormat = "mp3" | "wav";

export interface GeneratedMusicAsset {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
}

export interface MusicGenerationSourceImage {
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
}

export interface MusicGenerationProviderConfiguredContext {
  cfg?: OpenClawConfig;
  agentDir?: string;
}

export interface MusicGenerationRequest {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
}

export interface MusicGenerationResult {
  tracks: GeneratedMusicAsset[];
  model?: string;
  lyrics?: string[];
  metadata?: Record<string, unknown>;
}

export interface MusicGenerationIgnoredOverride {
  key: "lyrics" | "instrumental" | "durationSeconds" | "format";
  value: string | boolean | number;
}

export type MusicGenerationMode = "generate" | "edit";

export interface MusicGenerationModeCapabilities {
  maxTracks?: number;
  maxDurationSeconds?: number;
  supportsLyrics?: boolean;
  supportsInstrumental?: boolean;
  supportsDuration?: boolean;
  supportsFormat?: boolean;
  supportedFormats?: readonly MusicGenerationOutputFormat[];
  supportedFormatsByModel?: Readonly<Record<string, readonly MusicGenerationOutputFormat[]>>;
}

export type MusicGenerationEditCapabilities = MusicGenerationModeCapabilities & {
  enabled: boolean;
  maxInputImages?: number;
};

export type MusicGenerationProviderCapabilities = MusicGenerationModeCapabilities & {
  maxInputImages?: number;
  generate?: MusicGenerationModeCapabilities;
  edit?: MusicGenerationEditCapabilities;
};

export interface MusicGenerationNormalization {
  durationSeconds?: MediaNormalizationEntry<number>;
}

export interface MusicGenerationProvider {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: MusicGenerationProviderCapabilities;
  isConfigured?: (ctx: MusicGenerationProviderConfiguredContext) => boolean;
  generateMusic: (req: MusicGenerationRequest) => Promise<MusicGenerationResult>;
}
