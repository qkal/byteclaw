import type {
  VideoGenerationMode,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationTransformCapabilities,
} from "./types.js";

export function resolveVideoGenerationMode(params: {
  inputImageCount?: number;
  inputVideoCount?: number;
}): VideoGenerationMode | null {
  const inputImageCount = params.inputImageCount ?? 0;
  const inputVideoCount = params.inputVideoCount ?? 0;
  if (inputImageCount > 0 && inputVideoCount > 0) {
    return null;
  }
  if (inputVideoCount > 0) {
    return "videoToVideo";
  }
  if (inputImageCount > 0) {
    return "imageToVideo";
  }
  return "generate";
}

export function listSupportedVideoGenerationModes(
  provider: Pick<VideoGenerationProvider, "capabilities">,
): VideoGenerationMode[] {
  const modes: VideoGenerationMode[] = ["generate"];
  const {imageToVideo} = provider.capabilities;
  if (imageToVideo?.enabled) {
    modes.push("imageToVideo");
  }
  const {videoToVideo} = provider.capabilities;
  if (videoToVideo?.enabled) {
    modes.push("videoToVideo");
  }
  return modes;
}

export function resolveVideoGenerationModeCapabilities(params: {
  provider?: Pick<VideoGenerationProvider, "capabilities">;
  inputImageCount?: number;
  inputVideoCount?: number;
}): {
  mode: VideoGenerationMode | null;
  capabilities: VideoGenerationModeCapabilities | VideoGenerationTransformCapabilities | undefined;
} {
  const mode = resolveVideoGenerationMode(params);
  const capabilities = params.provider?.capabilities;
  if (!capabilities) {
    return { capabilities: undefined, mode };
  }
  if (mode === "generate") {
    return {
      capabilities: capabilities.generate,
      mode,
    };
  }
  if (mode === "imageToVideo") {
    return {
      capabilities: capabilities.imageToVideo,
      mode,
    };
  }
  if (mode === "videoToVideo") {
    return {
      capabilities: capabilities.videoToVideo,
      mode,
    };
  }
  return {
    capabilities: undefined,
    mode,
  };
}
