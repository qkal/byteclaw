import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveSTTConfig, transcribeAudio } from "./stt.js";
import { convertSilkToWav, formatDuration, isVoiceAttachment } from "./utils/audio-convert.js";
import { downloadFile } from "./utils/file-utils.js";
import { getQQBotMediaDir } from "./utils/platform.js";

export interface RawAttachment {
  content_type: string;
  url: string;
  filename?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export type TranscriptSource = "stt" | "asr" | "fallback";

/** Normalized attachment output consumed by the gateway. */
export interface ProcessedAttachments {
  attachmentInfo: string;
  imageUrls: string[];
  imageMediaTypes: string[];
  voiceAttachmentPaths: string[];
  voiceAttachmentUrls: string[];
  voiceAsrReferTexts: string[];
  voiceTranscripts: string[];
  voiceTranscriptSources: TranscriptSource[];
  attachmentLocalPaths: (string | null)[];
}

interface ProcessContext {
  accountId: string;
  cfg: unknown;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

const EMPTY_RESULT: ProcessedAttachments = {
  attachmentInfo: "",
  attachmentLocalPaths: [],
  imageMediaTypes: [],
  imageUrls: [],
  voiceAsrReferTexts: [],
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceTranscriptSources: [],
  voiceTranscripts: [],
};

/** Download, convert, transcribe, and classify inbound attachments. */
export async function processAttachments(
  attachments: RawAttachment[] | undefined,
  ctx: ProcessContext,
): Promise<ProcessedAttachments> {
  if (!attachments?.length) {
    return EMPTY_RESULT;
  }

  const { accountId, cfg, log } = ctx;
  const downloadDir = getQQBotMediaDir("downloads");
  const prefix = `[qqbot:${accountId}]`;

  const imageUrls: string[] = [];
  const imageMediaTypes: string[] = [];
  const voiceAttachmentPaths: string[] = [];
  const voiceAttachmentUrls: string[] = [];
  const voiceAsrReferTexts: string[] = [];
  const voiceTranscripts: string[] = [];
  const voiceTranscriptSources: TranscriptSource[] = [];
  const attachmentLocalPaths: (string | null)[] = [];
  const otherAttachments: string[] = [];

  // Phase 1: download all attachments in parallel.
  const downloadTasks = attachments.map(async (att) => {
    const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;
    const isVoice = isVoiceAttachment(att);
    const wavUrl =
      isVoice && att.voice_wav_url
        ? (att.voice_wav_url.startsWith("//")
          ? `https:${att.voice_wav_url}`
          : att.voice_wav_url)
        : "";

    let localPath: string | null = null;
    let audioPath: string | null = null;

    if (isVoice && wavUrl) {
      const wavLocalPath = await downloadFile(wavUrl, downloadDir);
      if (wavLocalPath) {
        localPath = wavLocalPath;
        audioPath = wavLocalPath;
        log?.info(
          `${prefix} Voice attachment: ${att.filename}, downloaded WAV directly (skip SILK→WAV)`,
        );
      } else {
        log?.error(`${prefix} Failed to download voice_wav_url, falling back to original URL`);
      }
    }

    if (!localPath) {
      localPath = await downloadFile(attUrl, downloadDir, att.filename);
    }

    return { att, attUrl, audioPath, isVoice, localPath };
  });

  const downloadResults = await Promise.all(downloadTasks);

  // Phase 2: convert/transcribe voice attachments and classify everything else.
  const processTasks = downloadResults.map(
    async ({ att, attUrl, isVoice, localPath, audioPath }) => {
      const asrReferText = normalizeOptionalString(att.asr_refer_text) ?? "";
      const wavUrl =
        isVoice && att.voice_wav_url
          ? (att.voice_wav_url.startsWith("//")
            ? `https:${att.voice_wav_url}`
            : att.voice_wav_url)
          : "";
      const voiceSourceUrl = wavUrl || attUrl;

      const meta = {
        asrReferText: isVoice && asrReferText ? asrReferText : undefined,
        voiceUrl: isVoice && voiceSourceUrl ? voiceSourceUrl : undefined,
      };

      if (localPath) {
        if (att.content_type?.startsWith("image/")) {
          log?.info(`${prefix} Downloaded attachment to: ${localPath}`);
          return { contentType: att.content_type, localPath, meta, type: "image" as const };
        } else if (isVoice) {
          log?.info(`${prefix} Downloaded attachment to: ${localPath}`);
          return processVoiceAttachment(
            localPath,
            audioPath,
            att,
            asrReferText,
            cfg,
            downloadDir,
            log,
            prefix,
          );
        } else {
          log?.info(`${prefix} Downloaded attachment to: ${localPath}`);
          return { filename: att.filename, localPath, meta, type: "other" as const };
        }
      } else {
        log?.error(`${prefix} Failed to download: ${attUrl}`);
        if (att.content_type?.startsWith("image/")) {
          return {
            attUrl,
            contentType: att.content_type,
            localPath: null,
            meta,
            type: "image-fallback" as const,
          };
        } else if (isVoice && asrReferText) {
          log?.info(`${prefix} Voice attachment download failed, using asr_refer_text fallback`);
          return {
            localPath: null,
            meta,
            transcript: asrReferText,
            type: "voice-fallback" as const,
          };
        } else {
          return {
            filename: att.filename ?? att.content_type,
            localPath: null,
            meta,
            type: "other-fallback" as const,
          };
        }
      }
    },
  );

  const processResults = await Promise.all(processTasks);

  // Phase 3: collect results in the original attachment order.
  for (const result of processResults) {
    if (result.meta.voiceUrl) {
      voiceAttachmentUrls.push(result.meta.voiceUrl);
    }
    if (result.meta.asrReferText) {
      voiceAsrReferTexts.push(result.meta.asrReferText);
    }

    if (result.type === "image" && result.localPath) {
      imageUrls.push(result.localPath);
      imageMediaTypes.push(result.contentType);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "voice" && result.localPath) {
      voiceAttachmentPaths.push(result.localPath);
      voiceTranscripts.push(result.transcript);
      voiceTranscriptSources.push(result.transcriptSource);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "other" && result.localPath) {
      otherAttachments.push(`[Attachment: ${result.localPath}]`);
      attachmentLocalPaths.push(result.localPath);
    } else if (result.type === "image-fallback") {
      imageUrls.push(result.attUrl);
      imageMediaTypes.push(result.contentType);
      attachmentLocalPaths.push(null);
    } else if (result.type === "voice-fallback") {
      voiceTranscripts.push(result.transcript);
      voiceTranscriptSources.push("asr");
      attachmentLocalPaths.push(null);
    } else if (result.type === "other-fallback") {
      otherAttachments.push(`[Attachment: ${result.filename}] (download failed)`);
      attachmentLocalPaths.push(null);
    }
  }

  const attachmentInfo = otherAttachments.length > 0 ? "\n" + otherAttachments.join("\n") : "";

  return {
    attachmentInfo,
    attachmentLocalPaths,
    imageMediaTypes,
    imageUrls,
    voiceAsrReferTexts,
    voiceAttachmentPaths,
    voiceAttachmentUrls,
    voiceTranscriptSources,
    voiceTranscripts,
  };
}

/** Format voice transcripts into user-visible text. */
export function formatVoiceText(transcripts: string[]): string {
  if (transcripts.length === 0) {
    return "";
  }
  return transcripts.length === 1
    ? `[Voice message] ${transcripts[0]}`
    : transcripts.map((t, i) => `[Voice ${i + 1}] ${t}`).join("\n");
}

// Internal helpers.

type VoiceResult =
  | {
      localPath: string;
      type: "voice";
      transcript: string;
      transcriptSource: TranscriptSource;
      meta: { voiceUrl?: string; asrReferText?: string };
    }
  | {
      localPath: string;
      type: "voice";
      transcript: string;
      transcriptSource: TranscriptSource;
      meta: { voiceUrl?: string; asrReferText?: string };
    };

async function processVoiceAttachment(
  localPath: string,
  audioPath: string | null,
  att: RawAttachment,
  asrReferText: string,
  cfg: unknown,
  downloadDir: string,
  log: ProcessContext["log"],
  prefix: string,
): Promise<VoiceResult> {
  const wavUrl = att.voice_wav_url
    ? (att.voice_wav_url.startsWith("//")
      ? `https:${att.voice_wav_url}`
      : att.voice_wav_url)
    : "";
  const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;
  const voiceSourceUrl = wavUrl || attUrl;
  const meta = {
    asrReferText: asrReferText || undefined,
    voiceUrl: voiceSourceUrl || undefined,
  };

  const sttCfg = resolveSTTConfig(cfg as Record<string, unknown>);
  if (!sttCfg) {
    if (asrReferText) {
      log?.info(
        `${prefix} Voice attachment: ${att.filename} (STT not configured, using asr_refer_text fallback)`,
      );
      return { localPath, meta, transcript: asrReferText, transcriptSource: "asr", type: "voice" };
    }
    log?.info(
      `${prefix} Voice attachment: ${att.filename} (STT not configured, skipping transcription)`,
    );
    return {
      localPath,
      meta,
      transcript: "[Voice message - transcription unavailable because STT is not configured]",
      transcriptSource: "fallback",
      type: "voice",
    };
  }

  // Convert SILK input to WAV before STT when necessary.
  if (!audioPath) {
    log?.info(`${prefix} Voice attachment: ${att.filename}, converting SILK→WAV...`);
    try {
      const wavResult = await convertSilkToWav(localPath, downloadDir);
      if (wavResult) {
        audioPath = wavResult.wavPath;
        log?.info(
          `${prefix} Voice converted: ${wavResult.wavPath} (${formatDuration(wavResult.duration)})`,
        );
      } else {
        audioPath = localPath;
      }
    } catch (error) {
      log?.error(
        `${prefix} Voice conversion failed: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      if (asrReferText) {
        return {
          localPath,
          meta,
          transcript: asrReferText,
          transcriptSource: "asr",
          type: "voice",
        };
      }
      return {
        localPath,
        meta,
        transcript: "[Voice message - format conversion failed]",
        transcriptSource: "fallback",
        type: "voice",
      };
    }
  }

  // Run speech-to-text on the prepared audio file.
  try {
    const transcript = await transcribeAudio(audioPath, cfg as Record<string, unknown>);
    if (transcript) {
      log?.info(`${prefix} STT transcript: ${transcript.slice(0, 100)}...`);
      return { localPath, meta, transcript, transcriptSource: "stt", type: "voice" };
    }
    if (asrReferText) {
      log?.info(`${prefix} STT returned empty result, using asr_refer_text fallback`);
      return { localPath, meta, transcript: asrReferText, transcriptSource: "asr", type: "voice" };
    }
    log?.info(`${prefix} STT returned empty result`);
    return {
      localPath,
      meta,
      transcript: "[Voice message - transcription returned an empty result]",
      transcriptSource: "fallback",
      type: "voice",
    };
  } catch (error) {
    log?.error(
      `${prefix} STT failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
    if (asrReferText) {
      return { localPath, meta, transcript: asrReferText, transcriptSource: "asr", type: "voice" };
    }
    return {
      localPath,
      meta,
      transcript: "[Voice message - transcription failed]",
      transcriptSource: "fallback",
      type: "voice",
    };
  }
}
