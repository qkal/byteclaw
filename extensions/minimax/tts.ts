export const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";

export const MINIMAX_TTS_MODELS = ["speech-2.8-hd", "speech-01-240228"] as const;

export const MINIMAX_TTS_VOICES = [
  "English_expressive_narrator",
  "Chinese (Mandarin)_Warm_Girl",
  "Chinese (Mandarin)_Lively_Girl",
  "Chinese (Mandarin)_Gentle_Boy",
  "Chinese (Mandarin)_Steady_Boy",
] as const;

export function normalizeMinimaxTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_MINIMAX_TTS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export async function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: string;
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    model,
    voiceId,
    speed = 1,
    vol = 1,
    pitch = 0,
    format = "mp3",
    sampleRate = 32_000,
    timeoutMs,
  } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
      body: JSON.stringify({
        audio_setting: {
          format,
          sample_rate: sampleRate,
        },
        model,
        text,
        voice_setting: {
          pitch,
          speed,
          voice_id: voiceId,
          vol,
        },
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`MiniMax TTS API error (${response.status})${errBody ? `: ${errBody}` : ""}`);
    }

    const body = (await response.json()) as { data?: { audio?: string } };
    const hexAudio = body?.data?.audio;
    if (!hexAudio) {
      throw new Error("MiniMax TTS API returned no audio data");
    }

    return Buffer.from(hexAudio, "hex");
  } finally {
    clearTimeout(timeout);
  }
}
