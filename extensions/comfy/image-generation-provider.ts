import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import {
  DEFAULT_COMFY_MODEL,
  _setComfyFetchGuardForTesting,
  isComfyCapabilityConfigured,
  runComfyWorkflow,
} from "./workflow-runtime.js";

export { _setComfyFetchGuardForTesting };

export function buildComfyImageGenerationProvider(): ImageGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: 1,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsSize: false,
      },
      generate: {
        maxCount: 1,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsSize: false,
      },
    },
    defaultModel: DEFAULT_COMFY_MODEL,
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Comfy image generation currently supports at most one reference image");
      }

      const result = await runComfyWorkflow({
        agentDir: req.agentDir,
        authStore: req.authStore,
        capability: "image",
        cfg: req.cfg,
        inputImage: req.inputImages?.[0],
        model: req.model,
        outputKinds: ["images"],
        prompt: req.prompt,
        timeoutMs: req.timeoutMs,
      });

      const images: GeneratedImageAsset[] = result.assets.map((asset) => ({
        buffer: asset.buffer,
        fileName: asset.fileName,
        metadata: {
          nodeId: asset.nodeId,
          promptId: result.promptId,
        },
        mimeType: asset.mimeType,
      }));

      return {
        images,
        metadata: {
          outputNodeIds: result.outputNodeIds,
          promptId: result.promptId,
        },
        model: result.model,
      };
    },
    id: "comfy",
    isConfigured: ({ cfg, agentDir }) =>
      isComfyCapabilityConfigured({
        agentDir,
        capability: "image",
        cfg,
      }),
    label: "ComfyUI",
    models: [DEFAULT_COMFY_MODEL],
  };
}
