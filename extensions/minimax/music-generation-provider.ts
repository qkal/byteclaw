import { extensionForMime } from "openclaw/plugin-sdk/msteams";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_MINIMAX_MUSIC_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_MUSIC_MODEL = "music-2.5+";
const DEFAULT_TIMEOUT_MS = 120_000;

interface MinimaxBaseResp {
  status_code?: number;
  status_msg?: string;
}

interface MinimaxMusicCreateResponse {
  task_id?: string;
  audio?: string;
  audio_url?: string;
  lyrics?: string;
  data?: {
    audio?: string;
    audio_url?: string;
    lyrics?: string;
  };
  base_resp?: MinimaxBaseResp;
}

function resolveMinimaxMusicBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): string {
  const direct = normalizeOptionalString(cfg?.models?.providers?.minimax?.baseUrl);
  if (!direct) {
    return DEFAULT_MINIMAX_MUSIC_BASE_URL;
  }
  try {
    return new URL(direct).origin;
  } catch {
    return DEFAULT_MINIMAX_MUSIC_BASE_URL;
  }
}

function assertMinimaxBaseResp(baseResp: MinimaxBaseResp | undefined, context: string): void {
  if (!baseResp || typeof baseResp.status_code !== "number" || baseResp.status_code === 0) {
    return;
  }
  throw new Error(
    `${context} (${baseResp.status_code}): ${baseResp.status_msg ?? "unknown error"}`,
  );
}

function decodePossibleBinary(data: string): Buffer {
  const trimmed = data.trim();
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex");
  }
  return Buffer.from(trimmed, "base64");
}

function decodePossibleText(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex").toString("utf8").trim();
  }
  return trimmed;
}

function isLikelyRemoteUrl(value: string | undefined): boolean {
  const trimmed = normalizeOptionalString(value);
  return Boolean(trimmed && /^https?:\/\//iu.test(trimmed));
}

async function downloadTrackFromUrl(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedMusicAsset> {
  const response = await fetchWithTimeout(
    params.url,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "MiniMax generated music download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "audio/mpeg";
  const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    fileName: `track-1.${ext}`,
    mimeType,
  };
}

function buildPrompt(req: MusicGenerationRequest): string {
  const parts = [req.prompt.trim()];
  if (typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)) {
    parts.push(`Target duration: about ${Math.max(1, Math.round(req.durationSeconds))} seconds.`);
  }
  return parts.join("\n\n");
}

function resolveMinimaxMusicModel(model: string | undefined): string {
  const trimmed = normalizeOptionalString(model);
  if (!trimmed) {
    return DEFAULT_MINIMAX_MUSIC_MODEL;
  }
  return trimmed;
}

export function buildMinimaxMusicGenerationProvider(): MusicGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: false,
      },
      generate: {
        maxTracks: 1,
        supportedFormats: ["mp3"],
        supportsDuration: true,
        supportsFormat: true,
        supportsInstrumental: true,
        supportsLyrics: true,
      },
    },
    defaultModel: DEFAULT_MINIMAX_MUSIC_MODEL,
    async generateMusic(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("MiniMax music generation does not support image reference inputs.");
      }
      if (req.instrumental === true && normalizeOptionalString(req.lyrics)) {
        throw new Error("MiniMax music generation cannot use lyrics when instrumental=true.");
      }
      if (req.format && req.format !== "mp3") {
        throw new Error("MiniMax music generation currently supports mp3 output only.");
      }

      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: "minimax",
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          allowPrivateNetwork: false,
          baseUrl: resolveMinimaxMusicBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_MINIMAX_MUSIC_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
        });
      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");

      const model = resolveMinimaxMusicModel(req.model);
      const lyrics = normalizeOptionalString(req.lyrics);
      const body = {
        model,
        prompt: buildPrompt(req),
        ...(req.instrumental === true ? { is_instrumental: true } : {}),
        ...(lyrics ? { lyrics } : (req.instrumental === true ? {} : { lyrics_optimizer: true })),
        output_format: "url",
        audio_setting: {
          bitrate: 256_000,
          format: "mp3",
          sample_rate: 44_100,
        },
      };

      const { response: res, release } = await postJsonRequest({
        allowPrivateNetwork,
        body,
        dispatcherPolicy,
        fetchFn,
        headers: jsonHeaders,
        pinDns: false,
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        url: `${baseUrl}/v1/music_generation`,
      });

      try {
        await assertOkOrThrowHttpError(res, "MiniMax music generation failed");
        const payload = (await res.json()) as MinimaxMusicCreateResponse;
        assertMinimaxBaseResp(payload.base_resp, "MiniMax music generation failed");

        const audioCandidate =
          normalizeOptionalString(payload.audio) ?? normalizeOptionalString(payload.data?.audio);
        const audioUrl =
          normalizeOptionalString(payload.audio_url) ||
          normalizeOptionalString(payload.data?.audio_url) ||
          (isLikelyRemoteUrl(audioCandidate) ? audioCandidate : undefined);
        const inlineAudio = isLikelyRemoteUrl(audioCandidate) ? undefined : audioCandidate;
        const lyrics = decodePossibleText(payload.lyrics ?? payload.data?.lyrics ?? "");

        const track = audioUrl
          ? await downloadTrackFromUrl({
              fetchFn,
              timeoutMs: req.timeoutMs,
              url: audioUrl,
            })
          : (inlineAudio
            ? {
                buffer: decodePossibleBinary(inlineAudio),
                mimeType: "audio/mpeg",
                fileName: "track-1.mp3",
              }
            : null);
        if (!track) {
          throw new Error("MiniMax music generation response missing audio output");
        }

        return {
          tracks: [track],
          ...(lyrics ? { lyrics: [lyrics] } : {}),
          model,
          metadata: {
            ...(normalizeOptionalString(payload.task_id)
              ? { taskId: normalizeOptionalString(payload.task_id) }
              : {}),
            ...(audioUrl ? { audioUrl } : {}),
            instrumental: req.instrumental === true,
            ...(lyrics ? { requestedLyrics: true } : {}),
            ...(typeof req.durationSeconds === "number"
              ? { requestedDurationSeconds: req.durationSeconds }
              : {}),
          },
        };
      } finally {
        await release();
      }
    },
    id: "minimax",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "minimax",
      }),
    label: "MiniMax",
    models: [DEFAULT_MINIMAX_MUSIC_MODEL, "music-2.5", "music-2.0"],
  };
}
