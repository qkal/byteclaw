import {
  hasMediaNormalizationEntry,
  normalizeDurationToClosestMax,
} from "../media-generation/runtime-shared.js";
import { resolveMusicGenerationModeCapabilities } from "./capabilities.js";
import type {
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "./types.js";

export interface ResolvedMusicGenerationOverrides {
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
  normalization?: MusicGenerationNormalization;
}

export function resolveMusicGenerationOverrides(params: {
  provider: MusicGenerationProvider;
  model: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
}): ResolvedMusicGenerationOverrides {
  const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
    inputImageCount: params.inputImages?.length ?? 0,
    provider: params.provider,
  });
  const ignoredOverrides: MusicGenerationIgnoredOverride[] = [];
  const normalization: MusicGenerationNormalization = {};
  let { lyrics } = params;
  let { instrumental } = params;
  let { durationSeconds } = params;
  let { format } = params;

  if (!caps) {
    return {
      durationSeconds,
      format,
      ignoredOverrides,
      instrumental,
      lyrics,
    };
  }

  if (lyrics?.trim() && !caps.supportsLyrics) {
    ignoredOverrides.push({ key: "lyrics", value: lyrics });
    lyrics = undefined;
  }

  if (typeof instrumental === "boolean" && !caps.supportsInstrumental) {
    ignoredOverrides.push({ key: "instrumental", value: instrumental });
    instrumental = undefined;
  }

  if (typeof durationSeconds === "number" && !caps.supportsDuration) {
    ignoredOverrides.push({ key: "durationSeconds", value: durationSeconds });
    durationSeconds = undefined;
  } else if (typeof durationSeconds === "number") {
    const normalizedDurationSeconds = normalizeDurationToClosestMax(
      durationSeconds,
      caps.maxDurationSeconds,
    );
    if (
      typeof normalizedDurationSeconds === "number" &&
      normalizedDurationSeconds !== durationSeconds
    ) {
      normalization.durationSeconds = {
        applied: normalizedDurationSeconds,
        requested: durationSeconds,
      };
    }
    durationSeconds = normalizedDurationSeconds;
  }

  if (format) {
    const supportedFormats =
      caps.supportedFormatsByModel?.[params.model] ?? caps.supportedFormats ?? [];
    if (
      !caps.supportsFormat ||
      (supportedFormats.length > 0 && !supportedFormats.includes(format))
    ) {
      ignoredOverrides.push({ key: "format", value: format });
      format = undefined;
    }
  }

  return {
    durationSeconds,
    format,
    ignoredOverrides,
    instrumental,
    lyrics,
    normalization: hasMediaNormalizationEntry(normalization.durationSeconds)
      ? normalization
      : undefined,
  };
}
