import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "openclaw/plugin-sdk/music-generation";
import {
  DEFAULT_COMFY_MODEL,
  isComfyCapabilityConfigured,
  runComfyWorkflow,
} from "./workflow-runtime.js";

const COMFY_MAX_INPUT_IMAGES = 1;

function toGeneratedTrack(asset: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): GeneratedMusicAsset {
  return {
    buffer: asset.buffer,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
  };
}

function resolveInputImage(inputImage: MusicGenerationSourceImage | undefined) {
  if (!inputImage) {
    return undefined;
  }
  if (!inputImage.buffer) {
    throw new Error("Comfy music generation requires loaded reference image bytes.");
  }
  return {
    buffer: inputImage.buffer,
    fileName: inputImage.fileName,
    mimeType: inputImage.mimeType ?? "image/png",
  };
}

export function buildComfyMusicGenerationProvider(): MusicGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: true,
        maxInputImages: COMFY_MAX_INPUT_IMAGES,
      },
      generate: {},
    },
    defaultModel: DEFAULT_COMFY_MODEL,
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > COMFY_MAX_INPUT_IMAGES) {
        throw new Error(
          `Comfy music generation supports at most ${COMFY_MAX_INPUT_IMAGES} reference image.`,
        );
      }

      const result = await runComfyWorkflow({
        agentDir: req.agentDir,
        authStore: req.authStore,
        capability: "music",
        cfg: req.cfg,
        inputImage: resolveInputImage(req.inputImages?.[0]),
        model: req.model,
        outputKinds: ["audio"],
        prompt: req.prompt,
      });

      return {
        metadata: {
          inputImageCount: req.inputImages?.length ?? 0,
          outputNodeIds: result.outputNodeIds,
          promptId: result.promptId,
        },
        model: result.model,
        tracks: result.assets.map(toGeneratedTrack),
      };
    },
    id: "comfy",
    isConfigured: ({ cfg, agentDir }) =>
      isComfyCapabilityConfigured({
        agentDir,
        capability: "music",
        cfg,
      }),
    label: "ComfyUI",
    models: [DEFAULT_COMFY_MODEL],
  };
}
