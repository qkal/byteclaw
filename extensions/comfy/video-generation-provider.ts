import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_COMFY_MODEL,
  _setComfyFetchGuardForTesting,
  isComfyCapabilityConfigured,
  runComfyWorkflow,
} from "./workflow-runtime.js";

export { _setComfyFetchGuardForTesting };

function toComfyInputImage(inputImage?: VideoGenerationSourceAsset) {
  if (!inputImage) {
    return undefined;
  }
  if (!inputImage.buffer || !inputImage.mimeType) {
    throw new Error("Comfy video generation requires a local reference image file");
  }
  return {
    buffer: inputImage.buffer,
    fileName: inputImage.fileName,
    mimeType: inputImage.mimeType,
  };
}

export function buildComfyVideoGenerationProvider(): VideoGenerationProvider {
  return {
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsAspectRatio: false,
        supportsAudio: false,
        supportsResolution: false,
        supportsSize: false,
        supportsWatermark: false,
      },
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxVideos: 1,
        supportsAspectRatio: false,
        supportsAudio: false,
        supportsResolution: false,
        supportsSize: false,
        supportsWatermark: false,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    defaultModel: DEFAULT_COMFY_MODEL,
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Comfy video generation currently supports at most one reference image");
      }
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Comfy video generation does not support input videos");
      }

      const result = await runComfyWorkflow({
        agentDir: req.agentDir,
        authStore: req.authStore,
        capability: "video",
        cfg: req.cfg,
        inputImage: toComfyInputImage(req.inputImages?.[0]),
        model: req.model,
        outputKinds: ["gifs", "videos"],
        prompt: req.prompt,
        timeoutMs: req.timeoutMs,
      });

      const videos: GeneratedVideoAsset[] = result.assets.map((asset) => ({
        buffer: asset.buffer,
        fileName: asset.fileName,
        metadata: {
          nodeId: asset.nodeId,
          promptId: result.promptId,
        },
        mimeType: asset.mimeType,
      }));

      return {
        metadata: {
          outputNodeIds: result.outputNodeIds,
          promptId: result.promptId,
        },
        model: result.model,
        videos,
      };
    },
    id: "comfy",
    isConfigured: ({ cfg, agentDir }) =>
      isComfyCapabilityConfigured({
        agentDir,
        capability: "video",
        cfg,
      }),
    label: "ComfyUI",
    models: [DEFAULT_COMFY_MODEL],
  };
}
