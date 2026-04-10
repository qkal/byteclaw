import {
  hasMediaNormalizationEntry,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
} from "../media-generation/runtime-shared.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import {
  normalizeVideoGenerationDuration,
  resolveVideoGenerationSupportedDurations,
} from "./duration-support.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationProvider,
  VideoGenerationResolution,
} from "./types.js";

export interface ResolvedVideoGenerationOverrides {
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  audio?: boolean;
  watermark?: boolean;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
  normalization?: VideoGenerationNormalization;
}

export function resolveVideoGenerationOverrides(params: {
  provider: VideoGenerationProvider;
  model: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImageCount?: number;
  inputVideoCount?: number;
}): ResolvedVideoGenerationOverrides {
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
    provider: params.provider,
  });
  const ignoredOverrides: VideoGenerationIgnoredOverride[] = [];
  const normalization: VideoGenerationNormalization = {};
  let {size} = params;
  let {aspectRatio} = params;
  let {resolution} = params;
  let {audio} = params;
  let {watermark} = params;

  if (caps) {
    if (size && (caps.sizes?.length ?? 0) > 0 && caps.supportsSize) {
      const normalizedSize = resolveClosestSize({
        requestedAspectRatio: aspectRatio,
        requestedSize: size,
        supportedSizes: caps.sizes,
      });
      if (normalizedSize && normalizedSize !== size) {
        normalization.size = {
          applied: normalizedSize,
          requested: size,
        };
      }
      size = normalizedSize;
    }

    if (!caps.supportsSize && size) {
      let translated = false;
      if (caps.supportsAspectRatio) {
        const normalizedAspectRatio = resolveClosestAspectRatio({
          requestedAspectRatio: aspectRatio,
          requestedSize: size,
          supportedAspectRatios: caps.aspectRatios,
        });
        if (normalizedAspectRatio) {
          aspectRatio = normalizedAspectRatio;
          normalization.aspectRatio = {
            applied: normalizedAspectRatio,
            derivedFrom: "size",
          };
          translated = true;
        }
      }
      if (!translated) {
        ignoredOverrides.push({ key: "size", value: size });
      }
      size = undefined;
    }

    if (aspectRatio && (caps.aspectRatios?.length ?? 0) > 0 && caps.supportsAspectRatio) {
      const normalizedAspectRatio = resolveClosestAspectRatio({
        requestedAspectRatio: aspectRatio,
        requestedSize: size,
        supportedAspectRatios: caps.aspectRatios,
      });
      if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) {
        normalization.aspectRatio = {
          applied: normalizedAspectRatio,
          requested: aspectRatio,
        };
      }
      aspectRatio = normalizedAspectRatio;
    } else if (!caps.supportsAspectRatio && aspectRatio) {
      const derivedSize =
        caps.supportsSize && !size
          ? resolveClosestSize({
              requestedAspectRatio: aspectRatio,
              requestedSize: params.size,
              supportedSizes: caps.sizes,
            })
          : undefined;
      if (derivedSize) {
        size = derivedSize;
        normalization.size = {
          applied: derivedSize,
          derivedFrom: "aspectRatio",
        };
      } else {
        ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
      }
      aspectRatio = undefined;
    }

    if (resolution && (caps.resolutions?.length ?? 0) > 0 && caps.supportsResolution) {
      const normalizedResolution = resolveClosestResolution({
        requestedResolution: resolution,
        supportedResolutions: caps.resolutions,
      });
      if (normalizedResolution && normalizedResolution !== resolution) {
        normalization.resolution = {
          applied: normalizedResolution,
          requested: resolution,
        };
      }
      resolution = normalizedResolution;
    } else if (resolution && !caps.supportsResolution) {
      ignoredOverrides.push({ key: "resolution", value: resolution });
      resolution = undefined;
    }

    if (typeof audio === "boolean" && !caps.supportsAudio) {
      ignoredOverrides.push({ key: "audio", value: audio });
      audio = undefined;
    }

    if (typeof watermark === "boolean" && !caps.supportsWatermark) {
      ignoredOverrides.push({ key: "watermark", value: watermark });
      watermark = undefined;
    }
  }

  if (caps && size && !caps.supportsSize) {
    ignoredOverrides.push({ key: "size", value: size });
    size = undefined;
  }
  if (caps && aspectRatio && !caps.supportsAspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }
  if (caps && resolution && !caps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (!normalization.size && size && params.size && params.size !== size) {
    normalization.size = {
      applied: size,
      requested: params.size,
    };
  }
  if (
    !normalization.aspectRatio &&
    aspectRatio &&
    ((!params.aspectRatio && params.size) || params.aspectRatio !== aspectRatio)
  ) {
    normalization.aspectRatio = {
      applied: aspectRatio,
      ...(params.aspectRatio ? { requested: params.aspectRatio } : {}),
      ...(!params.aspectRatio && params.size ? { derivedFrom: "size" } : {}),
    };
  }
  if (
    !normalization.resolution &&
    resolution &&
    params.resolution &&
    params.resolution !== resolution
  ) {
    normalization.resolution = {
      applied: resolution,
      requested: params.resolution,
    };
  }

  const requestedDurationSeconds =
    typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds)
      ? Math.max(1, Math.round(params.durationSeconds))
      : undefined;
  const durationSeconds = normalizeVideoGenerationDuration({
    durationSeconds: requestedDurationSeconds,
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
    model: params.model,
    provider: params.provider,
  });
  const supportedDurationSeconds = resolveVideoGenerationSupportedDurations({
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
    model: params.model,
    provider: params.provider,
  });

  if (
    typeof requestedDurationSeconds === "number" &&
    typeof durationSeconds === "number" &&
    requestedDurationSeconds !== durationSeconds
  ) {
    normalization.durationSeconds = {
      applied: durationSeconds,
      requested: requestedDurationSeconds,
      ...(supportedDurationSeconds?.length ? { supportedValues: supportedDurationSeconds } : {}),
    };
  }

  return {
    aspectRatio,
    audio,
    durationSeconds,
    ignoredOverrides,
    normalization:
      hasMediaNormalizationEntry(normalization.size) ||
      hasMediaNormalizationEntry(normalization.aspectRatio) ||
      hasMediaNormalizationEntry(normalization.resolution) ||
      hasMediaNormalizationEntry(normalization.durationSeconds)
        ? normalization
        : undefined,
    resolution,
    size,
    supportedDurationSeconds,
    watermark,
  };
}
