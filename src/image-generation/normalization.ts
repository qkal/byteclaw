import {
  type MediaNormalizationEntry,
  hasMediaNormalizationEntry,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
} from "../media-generation/runtime-shared.js";
import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationNormalization,
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "./types.js";

export interface ResolvedImageGenerationOverrides {
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
  normalization?: ImageGenerationNormalization;
}

function finalizeImageNormalization(
  normalization: ImageGenerationNormalization,
): ImageGenerationNormalization | undefined {
  return hasMediaNormalizationEntry(normalization.size) ||
    hasMediaNormalizationEntry(normalization.aspectRatio) ||
    hasMediaNormalizationEntry(normalization.resolution)
    ? normalization
    : undefined;
}

export function resolveImageGenerationOverrides(params: {
  provider: ImageGenerationProvider;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
}): ResolvedImageGenerationOverrides {
  const hasInputImages = (params.inputImages?.length ?? 0) > 0;
  const modeCaps = hasInputImages
    ? params.provider.capabilities.edit
    : params.provider.capabilities.generate;
  const {geometry} = params.provider.capabilities;
  const ignoredOverrides: ImageGenerationIgnoredOverride[] = [];
  const normalization: ImageGenerationNormalization = {};
  let {size} = params;
  let {aspectRatio} = params;
  let {resolution} = params;

  if (size && (geometry?.sizes?.length ?? 0) > 0 && modeCaps.supportsSize) {
    const normalizedSize = resolveClosestSize({
      requestedSize: size,
      supportedSizes: geometry?.sizes,
    });
    if (normalizedSize && normalizedSize !== size) {
      normalization.size = {
        applied: normalizedSize,
        requested: size,
      };
    }
    size = normalizedSize;
  }

  if (!modeCaps.supportsSize && size) {
    let translated = false;
    if (modeCaps.supportsAspectRatio) {
      const normalizedAspectRatio = resolveClosestAspectRatio({
        requestedAspectRatio: aspectRatio,
        requestedSize: size,
        supportedAspectRatios: geometry?.aspectRatios,
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

  if (aspectRatio && (geometry?.aspectRatios?.length ?? 0) > 0 && modeCaps.supportsAspectRatio) {
    const normalizedAspectRatio = resolveClosestAspectRatio({
      requestedAspectRatio: aspectRatio,
      requestedSize: size,
      supportedAspectRatios: geometry?.aspectRatios,
    });
    if (normalizedAspectRatio && normalizedAspectRatio !== aspectRatio) {
      normalization.aspectRatio = {
        applied: normalizedAspectRatio,
        requested: aspectRatio,
      };
    }
    aspectRatio = normalizedAspectRatio;
  } else if (!modeCaps.supportsAspectRatio && aspectRatio) {
    const derivedSize =
      modeCaps.supportsSize && !size
        ? resolveClosestSize({
            requestedAspectRatio: aspectRatio,
            requestedSize: params.size,
            supportedSizes: geometry?.sizes,
          })
        : undefined;
    let translated = false;
    if (derivedSize) {
      size = derivedSize;
      normalization.size = {
        applied: derivedSize,
        derivedFrom: "aspectRatio",
      };
      translated = true;
    }
    if (!translated) {
      ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    }
    aspectRatio = undefined;
  }

  if (resolution && (geometry?.resolutions?.length ?? 0) > 0 && modeCaps.supportsResolution) {
    const normalizedResolution = resolveClosestResolution({
      requestedResolution: resolution,
      supportedResolutions: geometry?.resolutions,
    });
    if (normalizedResolution && normalizedResolution !== resolution) {
      normalization.resolution = {
        applied: normalizedResolution,
        requested: resolution,
      };
    }
    resolution = normalizedResolution;
  } else if (!modeCaps.supportsResolution && resolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (size && !modeCaps.supportsSize) {
    ignoredOverrides.push({ key: "size", value: size });
    size = undefined;
  }

  if (aspectRatio && !modeCaps.supportsAspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }

  if (resolution && !modeCaps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (
    !normalization.aspectRatio &&
    aspectRatio &&
    ((!params.aspectRatio && params.size) || params.aspectRatio !== aspectRatio)
  ) {
    const entry: MediaNormalizationEntry<string> = {
      applied: aspectRatio,
      ...(params.aspectRatio ? { requested: params.aspectRatio } : {}),
      ...(!params.aspectRatio && params.size ? { derivedFrom: "size" } : {}),
    };
    normalization.aspectRatio = entry;
  }

  if (!normalization.size && size && params.size && params.size !== size) {
    normalization.size = {
      applied: size,
      requested: params.size,
    };
  }

  if (!normalization.aspectRatio && !params.aspectRatio && params.size && aspectRatio) {
    normalization.aspectRatio = {
      applied: aspectRatio,
      derivedFrom: "size",
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

  return {
    aspectRatio,
    ignoredOverrides,
    normalization: finalizeImageNormalization(normalization),
    resolution,
    size,
  };
}
