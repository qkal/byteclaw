import {
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
  describeImageWithModel,
  describeImagesWithModel,
} from "openclaw/plugin-sdk/media-understanding";
import {
  type ProviderRequestTransportOverrides,
  assertOkOrThrowHttpError,
  postJsonRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiHttpRequestConfig,
} from "./runtime-api.js";

export const DEFAULT_GOOGLE_AUDIO_BASE_URL = DEFAULT_GOOGLE_API_BASE_URL;
export const DEFAULT_GOOGLE_VIDEO_BASE_URL = DEFAULT_GOOGLE_API_BASE_URL;
const DEFAULT_GOOGLE_AUDIO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_AUDIO_PROMPT = "Transcribe the audio.";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

async function generateGeminiInlineDataText(params: {
  buffer: Buffer;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultPrompt: string;
  defaultMime: string;
  httpErrorLabel: string;
  missingTextError: string;
}): Promise<{ text: string; model: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = (() => {
    const trimmed = params.model?.trim();
    if (!trimmed) {
      return params.defaultModel;
    }
    return normalizeGoogleModelId(trimmed);
  })();
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      capability: params.defaultMime.startsWith("audio/") ? "audio" : "video",
      headers: params.headers,
      request: params.request,
      transport: "media-understanding",
    });
  const resolvedBaseUrl = baseUrl ?? params.defaultBaseUrl;
  const url = `${resolvedBaseUrl}/models/${model}:generateContent`;

  const prompt = (() => {
    const trimmed = params.prompt?.trim();
    return trimmed || params.defaultPrompt;
  })();

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              data: params.buffer.toString("base64"),
              mime_type: params.mime ?? params.defaultMime,
            },
          },
        ],
        role: "user",
      },
    ],
  };

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
    await assertOkOrThrowHttpError(res, params.httpErrorLabel);

    const payload = (await res.json()) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
      }[];
    };
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((part) => part?.text?.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) {
      throw new Error(params.missingTextError);
    }
    return { model, text };
  } finally {
    await release();
  }
}

export async function transcribeGeminiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_AUDIO_BASE_URL,
    defaultMime: "audio/wav",
    defaultModel: DEFAULT_GOOGLE_AUDIO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_AUDIO_PROMPT,
    httpErrorLabel: "Audio transcription failed",
    missingTextError: "Audio transcription response missing text",
  });
  return { model, text };
}

export async function describeGeminiVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_VIDEO_BASE_URL,
    defaultMime: "video/mp4",
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
    httpErrorLabel: "Video description failed",
    missingTextError: "Video description response missing text",
  });
  return { model, text };
}

export const googleMediaUnderstandingProvider: MediaUnderstandingProvider = {
  autoPriority: { audio: 40, image: 30, video: 10 },
  capabilities: ["image", "audio", "video"],
  defaultModels: {
    audio: DEFAULT_GOOGLE_AUDIO_MODEL,
    image: DEFAULT_GOOGLE_VIDEO_MODEL,
    video: DEFAULT_GOOGLE_VIDEO_MODEL,
  },
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
  describeVideo: describeGeminiVideo,
  id: "google",
  nativeDocumentInputs: ["pdf"],
  transcribeAudio: transcribeGeminiAudio,
};
