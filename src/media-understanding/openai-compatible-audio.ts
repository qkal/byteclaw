import path from "node:path";
import {
  assertOkOrThrowHttpError,
  postTranscriptionRequest,
  requireTranscriptionText,
  resolveProviderHttpRequestConfig,
} from "./shared.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "./types.js";

type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
  provider?: string;
};

function resolveModel(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  return trimmed || fallback;
}

export async function transcribeOpenAiCompatibleAudio(
  params: OpenAiCompatibleAudioParams,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      api: "openai-audio-transcriptions",
      baseUrl: params.baseUrl,
      capability: "audio",
      defaultBaseUrl: params.defaultBaseUrl,
      defaultHeaders: {
        authorization: `Bearer ${params.apiKey}`,
      },
      headers: params.headers,
      provider: params.provider,
      request: params.request,
      transport: "media-understanding",
    });
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model, params.defaultModel);
  const form = new FormData();
  const fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, fileName);
  form.append("model", model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }
  if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }

  const { response: res, release } = await postTranscriptionRequest({
    allowPrivateNetwork,
    body: form,
    dispatcherPolicy,
    fetchFn,
    headers,
    timeoutMs: params.timeoutMs,
    url,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as { text?: string };
    const text = requireTranscriptionText(
      payload.text,
      "Audio transcription response missing text",
    );
    return { model, text };
  } finally {
    await release();
  }
}
