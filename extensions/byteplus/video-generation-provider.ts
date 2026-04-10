import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { BYTEPLUS_BASE_URL } from "./models.js";

const DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-1-0-lite-t2v-250428";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120;

interface BytePlusTaskCreateResponse {
  id?: string;
}

interface BytePlusTaskResponse {
  id?: string;
  model?: string;
  status?: "running" | "failed" | "queued" | "succeeded" | "cancelled";
  error?: {
    code?: string;
    message?: string;
  };
  content?: {
    video_url?: string;
    last_frame_url?: string;
    file_url?: string;
  };
  duration?: number;
  ratio?: string;
  resolution?: string;
}

function resolveBytePlusVideoBaseUrl(req: VideoGenerationRequest): string {
  return (
    normalizeOptionalString(req.cfg?.models?.providers?.byteplus?.baseUrl) ?? BYTEPLUS_BASE_URL
  );
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function resolveBytePlusImageUrl(req: VideoGenerationRequest): string | undefined {
  const input = req.inputImages?.[0];
  if (!input) {
    return undefined;
  }
  const inputUrl = normalizeOptionalString(input.url);
  if (inputUrl) {
    return inputUrl;
  }
  if (!input.buffer) {
    throw new Error("BytePlus reference image is missing image data.");
  }
  return toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png");
}

async function pollBytePlusTask(params: {
  taskId: string;
  headers: Headers;
  timeoutMs?: number;
  baseUrl: string;
  fetchFn: typeof fetch;
}): Promise<BytePlusTaskResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetchWithTimeout(
      `${params.baseUrl}/contents/generations/tasks/${params.taskId}`,
      {
        headers: params.headers,
        method: "GET",
      },
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      params.fetchFn,
    );
    await assertOkOrThrowHttpError(response, "BytePlus video status request failed");
    const payload = (await response.json()) as BytePlusTaskResponse;
    switch (normalizeOptionalString(payload.status)) {
      case "succeeded": {
        return payload;
      }
      case "failed":
      case "cancelled": {
        throw new Error(
          normalizeOptionalString(payload.error?.message) || "BytePlus video generation failed",
        );
      }
      case "queued":
      case "running":
      default: {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        break;
      }
    }
  }
  throw new Error(`BytePlus video generation task ${params.taskId} did not finish in time`);
}

async function downloadBytePlusVideo(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedVideoAsset> {
  const response = await fetchWithTimeout(
    params.url,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "BytePlus generated video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
    mimeType,
  };
}

export function buildBytePlusVideoGenerationProvider(): VideoGenerationProvider {
  return {
    capabilities: {
      generate: {
        maxDurationSeconds: 12,
        maxVideos: 1,
        supportsAspectRatio: true,
        supportsAudio: true,
        supportsResolution: true,
        supportsWatermark: true,
      },
      imageToVideo: {
        enabled: true,
        maxDurationSeconds: 12,
        maxInputImages: 1,
        maxVideos: 1,
        supportsAspectRatio: true,
        supportsAudio: true,
        supportsResolution: true,
        supportsWatermark: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    defaultModel: DEFAULT_BYTEPLUS_VIDEO_MODEL,
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("BytePlus video generation does not support video reference inputs.");
      }
      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: "byteplus",
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("BytePlus API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          allowPrivateNetwork: false,
          baseUrl: resolveBytePlusVideoBaseUrl(req),
          capability: "video",
          defaultBaseUrl: BYTEPLUS_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "byteplus",
          transport: "http",
        });
      const content: Record<string, unknown>[] = [{ text: req.prompt, type: "text" }];
      const imageUrl = resolveBytePlusImageUrl(req);
      if (imageUrl) {
        content.push({
          image_url: { url: imageUrl },
          role: "first_frame",
          type: "image_url",
        });
      }
      const body: Record<string, unknown> = {
        content,
        model: normalizeOptionalString(req.model) || DEFAULT_BYTEPLUS_VIDEO_MODEL,
      };
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      if (aspectRatio) {
        body.ratio = aspectRatio;
      }
      if (req.resolution) {
        body.resolution = req.resolution;
      }
      if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
        body.duration = Math.max(1, Math.round(req.durationSeconds));
      }
      if (typeof req.audio === "boolean") {
        body.generate_audio = req.audio;
      }
      if (typeof req.watermark === "boolean") {
        body.watermark = req.watermark;
      }

      const { response, release } = await postJsonRequest({
        allowPrivateNetwork,
        body,
        dispatcherPolicy,
        fetchFn,
        headers,
        timeoutMs: req.timeoutMs,
        url: `${baseUrl}/contents/generations/tasks`,
      });
      try {
        await assertOkOrThrowHttpError(response, "BytePlus video generation failed");
        const submitted = (await response.json()) as BytePlusTaskCreateResponse;
        const taskId = normalizeOptionalString(submitted.id);
        if (!taskId) {
          throw new Error("BytePlus video generation response missing task id");
        }
        const completed = await pollBytePlusTask({
          baseUrl,
          fetchFn,
          headers,
          taskId,
          timeoutMs: req.timeoutMs,
        });
        const videoUrl = normalizeOptionalString(completed.content?.video_url);
        if (!videoUrl) {
          throw new Error("BytePlus video generation completed without a video URL");
        }
        const video = await downloadBytePlusVideo({
          fetchFn,
          timeoutMs: req.timeoutMs,
          url: videoUrl,
        });
        return {
          metadata: {
            duration: completed.duration,
            ratio: completed.ratio,
            resolution: completed.resolution,
            status: completed.status,
            taskId,
            videoUrl,
          },
          model: completed.model ?? req.model ?? DEFAULT_BYTEPLUS_VIDEO_MODEL,
          videos: [video],
        };
      } finally {
        await release();
      }
    },
    id: "byteplus",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "byteplus",
      }),
    label: "BytePlus",
    models: [
      DEFAULT_BYTEPLUS_VIDEO_MODEL,
      "seedance-1-0-lite-i2v-250428",
      "seedance-1-0-pro-250528",
      "seedance-1-5-pro-251215",
    ],
  };
}
