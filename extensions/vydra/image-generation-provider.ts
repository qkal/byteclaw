import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { assertOkOrThrowHttpError, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_VYDRA_IMAGE_MODEL,
  downloadVydraAsset,
  extractVydraResultUrls,
  resolveCompletedVydraPayload,
  resolveVydraRequestContext,
  resolveVydraResponseJobId,
  resolveVydraResponseStatus,
} from "./shared.js";

export function buildVydraImageGenerationProvider(): ImageGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: false,
        maxCount: 1,
        maxInputImages: 0,
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
    defaultModel: DEFAULT_VYDRA_IMAGE_MODEL,
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error(
          "Vydra image generation currently supports text-to-image only in the bundled plugin.",
        );
      }
      if ((req.count ?? 1) > 1) {
        throw new Error("Vydra image generation supports at most one image per request.");
      }

      const { fetchFn, baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveVydraRequestContext({
          agentDir: req.agentDir,
          authStore: req.authStore,
          capability: "image",
          cfg: req.cfg,
        });

      const model = req.model?.trim() || DEFAULT_VYDRA_IMAGE_MODEL;
      const { response, release } = await postJsonRequest({
        allowPrivateNetwork,
        body: {
          model: "text-to-image",
          prompt: req.prompt,
        },
        dispatcherPolicy,
        fetchFn,
        headers,
        timeoutMs: req.timeoutMs,
        url: `${baseUrl}/models/${model}`,
      });

      try {
        await assertOkOrThrowHttpError(response, "Vydra image generation failed");
        const submitted = await response.json();
        const completedPayload = await resolveCompletedVydraPayload({
          baseUrl,
          fetchFn,
          headers,
          kind: "image",
          missingJobIdMessage: "Vydra image generation response missing job id",
          submitted,
          timeoutMs: req.timeoutMs,
        });
        const imageUrl = extractVydraResultUrls(completedPayload, "image")[0];
        if (!imageUrl) {
          throw new Error("Vydra image generation completed without an image URL");
        }
        const image = await downloadVydraAsset({
          fetchFn,
          kind: "image",
          timeoutMs: req.timeoutMs,
          url: imageUrl,
        });
        return {
          images: [
            {
              buffer: image.buffer,
              mimeType: image.mimeType,
              fileName: image.fileName,
            },
          ],
          metadata: {
            imageUrl,
            jobId:
              resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted),
            status: resolveVydraResponseStatus(completedPayload) ?? "completed",
          },
          model,
        };
      } finally {
        await release();
      }
    },
    id: "vydra",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "vydra",
      }),
    label: "Vydra",
    models: [DEFAULT_VYDRA_IMAGE_MODEL],
  };
}
