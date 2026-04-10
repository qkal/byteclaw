import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { assertOkOrThrowHttpError, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import {
  DEFAULT_VYDRA_VIDEO_MODEL,
  downloadVydraAsset,
  extractVydraResultUrls,
  resolveCompletedVydraPayload,
  resolveVydraRequestContext,
  resolveVydraResponseJobId,
  resolveVydraResponseStatus,
} from "./shared.js";

const VYDRA_KLING_MODEL = "kling";

function resolveVydraVideoRequestBody(
  req: Parameters<VideoGenerationProvider["generateVideo"]>[0],
) {
  const model = req.model?.trim() || DEFAULT_VYDRA_VIDEO_MODEL;
  if (model === VYDRA_KLING_MODEL) {
    const input = req.inputImages?.[0];
    const imageUrl = input?.url?.trim();
    if (!imageUrl) {
      throw new Error("Vydra kling currently requires a remote image URL reference.");
    }
    return {
      body: {
        prompt: req.prompt,
        // Vydra's kling route has been inconsistent about which field it requires.
        image_url: imageUrl,
        video_url: imageUrl,
      },
      model,
    };
  }
  if ((req.inputImages?.length ?? 0) > 0) {
    throw new Error(
      `Vydra ${model} does not support image reference inputs in the bundled plugin.`,
    );
  }
  return {
    body: {
      prompt: req.prompt,
    },
    model,
  };
}

export function buildVydraVideoGenerationProvider(): VideoGenerationProvider {
  return {
    capabilities: {
      generate: {
        maxVideos: 1,
      },
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxVideos: 1,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    defaultModel: DEFAULT_VYDRA_VIDEO_MODEL,
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Vydra video generation does not support video reference inputs.");
      }

      const { fetchFn, baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        await resolveVydraRequestContext({
          agentDir: req.agentDir,
          authStore: req.authStore,
          capability: "video",
          cfg: req.cfg,
        });
      const { model, body } = resolveVydraVideoRequestBody(req);
      const { response, release } = await postJsonRequest({
        allowPrivateNetwork,
        body,
        dispatcherPolicy,
        fetchFn,
        headers,
        timeoutMs: req.timeoutMs,
        url: `${baseUrl}/models/${model}`,
      });

      try {
        await assertOkOrThrowHttpError(response, "Vydra video generation failed");
        const submitted = await response.json();
        const completedPayload = await resolveCompletedVydraPayload({
          baseUrl,
          fetchFn,
          headers,
          kind: "video",
          missingJobIdMessage: "Vydra video generation response missing job id",
          submitted,
          timeoutMs: req.timeoutMs,
        });
        const videoUrl = extractVydraResultUrls(completedPayload, "video")[0];
        if (!videoUrl) {
          throw new Error("Vydra video generation completed without a video URL");
        }
        const video = await downloadVydraAsset({
          fetchFn,
          kind: "video",
          timeoutMs: req.timeoutMs,
          url: videoUrl,
        });
        return {
          metadata: {
            jobId:
              resolveVydraResponseJobId(completedPayload) ?? resolveVydraResponseJobId(submitted),
            status: resolveVydraResponseStatus(completedPayload) ?? "completed",
            videoUrl,
          },
          model,
          videos: [
            {
              buffer: video.buffer,
              mimeType: video.mimeType,
              fileName: video.fileName,
            },
          ],
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
    models: [DEFAULT_VYDRA_VIDEO_MODEL, VYDRA_KLING_MODEL],
  };
}
