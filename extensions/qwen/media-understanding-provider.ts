import {
  type MediaUnderstandingProvider,
  type OpenAiCompatibleVideoPayload,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  describeImageWithModel,
  describeImagesWithModel,
  resolveMediaUnderstandingString,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { QWEN_STANDARD_CN_BASE_URL, QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_VIDEO_MODEL = "qwen-vl-max-latest";
const DEFAULT_QWEN_VIDEO_PROMPT = "Describe the video in detail.";

function resolveQwenStandardBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
  providerId: string,
): string {
  const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
  if (!direct) {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
  try {
    const url = new URL(direct);
    if (url.hostname === "coding-intl.dashscope.aliyuncs.com") {
      return QWEN_STANDARD_GLOBAL_BASE_URL;
    }
    if (url.hostname === "coding.dashscope.aliyuncs.com") {
      return QWEN_STANDARD_CN_BASE_URL;
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  } catch {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
}

export async function describeQwenVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_QWEN_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_QWEN_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      api: "openai-completions",
      baseUrl: params.baseUrl,
      capability: "video",
      defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
      defaultHeaders: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      headers: params.headers,
      provider: "qwen",
      request: params.request,
      transport: "media-understanding",
    });

  const { response: res, release } = await postJsonRequest({
    allowPrivateNetwork,
    body: buildOpenAiCompatibleVideoRequestBody({
      buffer: params.buffer,
      mime,
      model,
      prompt,
    }),
    dispatcherPolicy,
    fetchFn,
    headers,
    timeoutMs: params.timeoutMs,
    url: `${baseUrl}/chat/completions`,
  });

  try {
    await assertOkOrThrowHttpError(res, "Qwen video description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Qwen video description response missing content");
    }
    return { model, text };
  } finally {
    await release();
  }
}

export function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    autoPriority: {
      video: 15,
    },
    capabilities: ["image", "video"],
    defaultModels: {
      image: "qwen-vl-max-latest",
      video: DEFAULT_QWEN_VIDEO_MODEL,
    },
    describeImage: describeImageWithModel,
    describeImages: describeImagesWithModel,
    describeVideo: describeQwenVideo,
    id: "qwen",
  };
}

export function resolveQwenMediaUnderstandingBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string {
  return resolveQwenStandardBaseUrl(cfg, "qwen");
}
