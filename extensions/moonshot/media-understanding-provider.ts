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

export const DEFAULT_MOONSHOT_VIDEO_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_MOONSHOT_VIDEO_MODEL = "kimi-k2.5";
const DEFAULT_MOONSHOT_VIDEO_PROMPT = "Describe the video.";

export async function describeMoonshotVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_MOONSHOT_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_MOONSHOT_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      api: "openai-completions",
      baseUrl: params.baseUrl,
      capability: "video",
      defaultBaseUrl: DEFAULT_MOONSHOT_VIDEO_BASE_URL,
      defaultHeaders: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      headers: params.headers,
      provider: "moonshot",
      request: params.request,
      transport: "media-understanding",
    });
  const url = `${baseUrl}/chat/completions`;

  const body = buildOpenAiCompatibleVideoRequestBody({
    buffer: params.buffer,
    mime,
    model,
    prompt,
  });

  const { response: res, release } = await postJsonRequest({
    allowPrivateNetwork,
    body,
    dispatcherPolicy,
    fetchFn,
    headers,
    timeoutMs: params.timeoutMs,
    url,
  });

  try {
    await assertOkOrThrowHttpError(res, "Moonshot video description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Moonshot video description response missing content");
    }
    return { model, text };
  } finally {
    await release();
  }
}

export const moonshotMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { video: 20 },
  capabilities: ["image", "video"],
  defaultModels: { image: "kimi-k2.5", video: DEFAULT_MOONSHOT_VIDEO_MODEL },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  describeVideo: describeMoonshotVideo,
  id: "moonshot",
};
