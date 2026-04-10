import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postTranscriptionRequest,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";

export const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
export const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_DEEPGRAM_AUDIO_MODEL;
}

interface DeepgramTranscriptResponse {
  results?: {
    channels?: {
      alternatives?: Array<{
        transcript?: string;
      }>;
    }[];
  };
}

export async function transcribeDeepgramAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveModel(params.model);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      capability: "audio",
      defaultBaseUrl: DEFAULT_DEEPGRAM_AUDIO_BASE_URL,
      defaultHeaders: {
        authorization: `Token ${params.apiKey}`,
        "content-type": params.mime ?? "application/octet-stream",
      },
      headers: params.headers,
      provider: "deepgram",
      request: params.request,
      transport: "media-understanding",
    });

  const url = new URL(`${baseUrl}/listen`);
  url.searchParams.set("model", model);
  if (params.language?.trim()) {
    url.searchParams.set("language", params.language.trim());
  }
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  const body = new Uint8Array(params.buffer);
  const { response: res, release } = await postTranscriptionRequest({
    allowPrivateNetwork,
    body,
    dispatcherPolicy,
    fetchFn,
    headers,
    timeoutMs: params.timeoutMs,
    url: url.toString(),
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as DeepgramTranscriptResponse;
    const transcript = requireTranscriptionText(
      payload.results?.channels?.[0]?.alternatives?.[0]?.transcript,
      "Audio transcription response missing transcript",
    );
    return { model, text: transcript };
  } finally {
    await release();
  }
}
