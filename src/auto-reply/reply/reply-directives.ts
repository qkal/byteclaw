import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { SILENT_REPLY_TOKEN, isSilentReplyPayloadText } from "../tokens.js";

export interface ReplyDirectiveParseResult {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
  replyToCurrent: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
}

export function parseReplyDirectives(
  raw: string,
  options: { currentMessageId?: string; silentToken?: string } = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw);
  let text = split.text ?? "";

  const replyParsed = parseInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    ({ text } = replyParsed);
  }

  const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent = isSilentReplyPayloadText(text, silentToken);
  if (isSilent) {
    text = "";
  }

  return {
    audioAsVoice: split.audioAsVoice,
    isSilent,
    mediaUrl: split.mediaUrl,
    mediaUrls: split.mediaUrls,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToId: replyParsed.replyToId,
    replyToTag: replyParsed.hasReplyTag,
    text,
  };
}
