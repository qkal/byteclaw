import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  type SsrFPolicy,
  fetchWithSsrFGuard,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_FAL_BASE_URL = "https://fal.run";
const DEFAULT_FAL_QUEUE_BASE_URL = "https://queue.fal.run";
const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/minimax/video-01-live";
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5000;

interface FalVideoResponse {
  video?: {
    url?: string;
    content_type?: string;
  };
  videos?: {
    url?: string;
    content_type?: string;
  }[];
  prompt?: string;
}

interface FalQueueResponse {
  status?: string;
  request_id?: string;
  response_url?: string;
  status_url?: string;
  cancel_url?: string;
  detail?: string;
  response?: FalVideoResponse;
  prompt?: string;
  error?: {
    message?: string;
  };
}

let falFetchGuard = fetchWithSsrFGuard;

export function _setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  falFetchGuard = impl ?? fetchWithSsrFGuard;
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildPolicy(allowPrivateNetwork: boolean): SsrFPolicy | undefined {
  return allowPrivateNetwork ? ssrfPolicyFromDangerouslyAllowPrivateNetwork(true) : undefined;
}

function extractFalVideoEntry(payload: FalVideoResponse) {
  if (normalizeOptionalString(payload.video?.url)) {
    return payload.video;
  }
  return payload.videos?.find((entry) => normalizeOptionalString(entry.url));
}

async function downloadFalVideo(
  url: string,
  policy: SsrFPolicy | undefined,
): Promise<GeneratedVideoAsset> {
  const { response, release } = await falFetchGuard({
    auditContext: "fal-video-download",
    policy,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    url,
  });
  try {
    await assertOkOrThrowHttpError(response, "fal generated video download failed");
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
      mimeType,
    };
  } finally {
    await release();
  }
}

function resolveFalQueueBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "fal.run") {
      url.hostname = "queue.fal.run";
      return url.toString().replace(/\/$/, "");
    }
    return baseUrl.replace(/\/$/, "");
  } catch {
    return DEFAULT_FAL_QUEUE_BASE_URL;
  }
}

function isFalMiniMaxLiveModel(model: string): boolean {
  return normalizeLowercaseStringOrEmpty(model) === DEFAULT_FAL_VIDEO_MODEL;
}

function buildFalVideoRequestBody(params: {
  req: VideoGenerationRequest;
  model: string;
}): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    prompt: params.req.prompt,
  };
  const input = params.req.inputImages?.[0];
  if (input) {
    requestBody.image_url = normalizeOptionalString(input.url)
      ? normalizeOptionalString(input.url)
      : (input.buffer
        ? toDataUrl(input.buffer, normalizeOptionalString(input.mimeType) ?? "image/png")
        : undefined);
  }
  // MiniMax Live on fal currently documents prompt + optional image_url only.
  // Keep the default model conservative so queue requests do not hang behind
  // Unsupported knobs such as duration/resolution/aspect-ratio overrides.
  if (isFalMiniMaxLiveModel(params.model)) {
    return requestBody;
  }
  const aspectRatio = normalizeOptionalString(params.req.aspectRatio);
  if (aspectRatio) {
    requestBody.aspect_ratio = aspectRatio;
  }
  const size = normalizeOptionalString(params.req.size);
  if (size) {
    requestBody.size = size;
  }
  if (params.req.resolution) {
    requestBody.resolution = params.req.resolution;
  }
  if (
    typeof params.req.durationSeconds === "number" &&
    Number.isFinite(params.req.durationSeconds)
  ) {
    requestBody.duration = Math.max(1, Math.round(params.req.durationSeconds));
  }
  return requestBody;
}

async function fetchFalJson(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
  auditContext: string;
  errorContext: string;
}): Promise<unknown> {
  const { response, release } = await falFetchGuard({
    auditContext: params.auditContext,
    dispatcherPolicy: params.dispatcherPolicy,
    init: params.init,
    policy: params.policy,
    timeoutMs: params.timeoutMs,
    url: params.url,
  });
  try {
    await assertOkOrThrowHttpError(response, params.errorContext);
    return await response.json();
  } finally {
    await release();
  }
}

async function waitForFalQueueResult(params: {
  statusUrl: string;
  responseUrl: string;
  headers: Headers;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
}): Promise<FalQueueResponse> {
  const deadline = Date.now() + params.timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const payload = (await fetchFalJson({
      auditContext: "fal-video-status",
      dispatcherPolicy: params.dispatcherPolicy,
      errorContext: "fal video status request failed",
      init: {
        headers: params.headers,
        method: "GET",
      },
      policy: params.policy,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      url: params.statusUrl,
    })) as FalQueueResponse;
    const status = normalizeOptionalString(payload.status)?.toUpperCase();
    if (status) {
      lastStatus = status;
    }
    if (status === "COMPLETED") {
      return (await fetchFalJson({
        auditContext: "fal-video-result",
        dispatcherPolicy: params.dispatcherPolicy,
        errorContext: "fal video result request failed",
        init: {
          headers: params.headers,
          method: "GET",
        },
        policy: params.policy,
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        url: params.responseUrl,
      })) as FalQueueResponse;
    }
    if (status === "FAILED" || status === "CANCELLED") {
      throw new Error(
        normalizeOptionalString(payload.detail) ||
          normalizeOptionalString(payload.error?.message) ||
          `fal video generation ${normalizeLowercaseStringOrEmpty(status)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`fal video generation did not finish in time (last status: ${lastStatus})`);
}

function extractFalVideoPayload(payload: FalQueueResponse): FalVideoResponse {
  if (payload.response && typeof payload.response === "object") {
    return payload.response;
  }
  return payload as FalVideoResponse;
}

export function buildFalVideoGenerationProvider(): VideoGenerationProvider {
  return {
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        maxVideos: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    defaultModel: DEFAULT_FAL_VIDEO_MODEL,
    async generateVideo(req) {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("fal video generation does not support video reference inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("fal video generation supports at most one image reference.");
      }
      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: "fal",
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("fal API key missing");
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          allowPrivateNetwork: false,
          baseUrl: normalizeOptionalString(req.cfg?.models?.providers?.fal?.baseUrl),
          capability: "video",
          defaultBaseUrl: DEFAULT_FAL_BASE_URL,
          defaultHeaders: {
            Authorization: `Key ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "fal",
          transport: "http",
        });
      const model = normalizeOptionalString(req.model) || DEFAULT_FAL_VIDEO_MODEL;
      const requestBody = buildFalVideoRequestBody({ model, req });
      const policy = buildPolicy(allowPrivateNetwork);
      const queueBaseUrl = resolveFalQueueBaseUrl(baseUrl);
      const submitted = (await fetchFalJson({
        auditContext: "fal-video-submit",
        dispatcherPolicy,
        errorContext: "fal video generation failed",
        init: {
          body: JSON.stringify(requestBody),
          headers,
          method: "POST",
        },
        policy,
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        url: `${queueBaseUrl}/${model}`,
      })) as FalQueueResponse;
      const statusUrl = normalizeOptionalString(submitted.status_url);
      const responseUrl = normalizeOptionalString(submitted.response_url);
      if (!statusUrl || !responseUrl) {
        throw new Error("fal video generation response missing queue URLs");
      }
      const payload = await waitForFalQueueResult({
        dispatcherPolicy,
        headers,
        policy,
        responseUrl,
        statusUrl,
        timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      });
      const videoPayload = extractFalVideoPayload(payload);
      const entry = extractFalVideoEntry(videoPayload);
      const url = normalizeOptionalString(entry?.url);
      if (!url) {
        throw new Error("fal video generation response missing output URL");
      }
      const video = await downloadFalVideo(url, policy);
      return {
        metadata: {
          ...(normalizeOptionalString(submitted.request_id)
            ? { requestId: normalizeOptionalString(submitted.request_id) }
            : {}),
          ...(videoPayload.prompt ? { prompt: videoPayload.prompt } : {}),
        },
        model,
        videos: [video],
      };
    },
    id: "fal",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "fal",
      }),
    label: "fal",
    models: [
      DEFAULT_FAL_VIDEO_MODEL,
      "fal-ai/kling-video/v2.1/master/text-to-video",
      "fal-ai/wan/v2.2-a14b/text-to-video",
      "fal-ai/wan/v2.2-a14b/image-to-video",
    ],
  };
}
