import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

interface DiscordAudioAttachment {
  content_type?: string;
  url?: string;
}

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): DiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.filter((att) => att.content_type?.startsWith("audio/"));
}

export async function resolveDiscordPreflightAudioMentionContext(params: {
  message: {
    attachments?: DiscordAudioAttachment[];
    content?: string;
  };
  isDirectMessage: boolean;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
}> {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  const hasTypedText = Boolean(params.message.content?.trim());
  const needsPreflightTranscription =
    !params.isDirectMessage &&
    params.shouldRequireMention &&
    hasAudioAttachment &&
    // `baseText` includes media placeholders; gate on typed text only.
    !hasTypedText &&
    params.mentionRegexes.length > 0;

  let transcript: string | undefined;
  if (needsPreflightTranscription) {
    if (params.abortSignal?.aborted) {
      return {
        hasAudioAttachment,
        hasTypedText,
      };
    }
    try {
      const { transcribeFirstAudio } = await import("./preflight-audio.runtime.js");
      if (params.abortSignal?.aborted) {
        return {
          hasAudioAttachment,
          hasTypedText,
        };
      }
      const audioUrls = audioAttachments
        .map((att) => att.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
      if (audioUrls.length > 0) {
        transcript = await transcribeFirstAudio({
          agentDir: undefined,
          cfg: params.cfg,
          ctx: {
            MediaTypes: audioAttachments
              .map((att) => att.content_type)
              .filter((contentType): contentType is string => Boolean(contentType)),
            MediaUrls: audioUrls,
          },
        });
        if (params.abortSignal?.aborted) {
          transcript = undefined;
        }
      }
    } catch (error) {
      logVerbose(`discord: audio preflight transcription failed: ${String(error)}`);
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText,
    transcript,
  };
}
