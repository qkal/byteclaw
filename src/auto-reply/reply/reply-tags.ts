import { parseInlineDirectives } from "../../utils/directive-tags.js";

export function extractReplyToTag(
  text?: string,
  currentMessageId?: string,
): {
  cleaned: string;
  replyToId?: string;
  replyToCurrent: boolean;
  hasTag: boolean;
} {
  const result = parseInlineDirectives(text, {
    currentMessageId,
    stripAudioTag: false,
  });
  return {
    cleaned: result.text,
    hasTag: result.hasReplyTag,
    replyToCurrent: result.replyToCurrent,
    replyToId: result.replyToId,
  };
}
