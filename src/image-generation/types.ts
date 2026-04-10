import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaNormalizationEntry } from "../media-generation/runtime-shared.js";

export interface GeneratedImageAsset {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
}

export type ImageGenerationResolution = "1K" | "2K" | "4K";

export type ImageGenerationIgnoredOverrideKey = "size" | "aspectRatio" | "resolution";

export interface ImageGenerationIgnoredOverride {
  key: ImageGenerationIgnoredOverrideKey;
  value: string;
}

export interface ImageGenerationSourceImage {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationProviderConfiguredContext {
  cfg?: OpenClawConfig;
  agentDir?: string;
}

export interface ImageGenerationRequest {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  timeoutMs?: number;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
}

export interface ImageGenerationResult {
  images: GeneratedImageAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationModeCapabilities {
  maxCount?: number;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
}

export type ImageGenerationEditCapabilities = ImageGenerationModeCapabilities & {
  enabled: boolean;
  maxInputImages?: number;
};

export interface ImageGenerationGeometryCapabilities {
  sizes?: string[];
  aspectRatios?: string[];
  resolutions?: ImageGenerationResolution[];
}

export interface ImageGenerationNormalization {
  size?: MediaNormalizationEntry<string>;
  aspectRatio?: MediaNormalizationEntry<string>;
  resolution?: MediaNormalizationEntry<ImageGenerationResolution>;
}

export interface ImageGenerationProviderCapabilities {
  generate: ImageGenerationModeCapabilities;
  edit: ImageGenerationEditCapabilities;
  geometry?: ImageGenerationGeometryCapabilities;
}

export interface ImageGenerationProvider {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: ImageGenerationProviderCapabilities;
  isConfigured?: (ctx: ImageGenerationProviderConfiguredContext) => boolean;
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
}
