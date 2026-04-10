import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import {
  SILENT_REPLY_TOKEN,
  isSilentReplyPrefixText,
  isSilentReplyText,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../tokens.js";
import type { ReplyDirectiveParseResult } from "./reply-directives.js";

interface PendingReplyState {
  explicitId?: string;
  sawCurrent: boolean;
  hasTag: boolean;
}

type ParsedChunk = ReplyDirectiveParseResult & {
  replyToExplicitId?: string;
};

interface ConsumeOptions {
  final?: boolean;
  silentToken?: string;
}

const splitTrailingDirective = (text: string): { text: string; tail: string } => {
  const openIndex = text.lastIndexOf("[[");
  if (openIndex === -1) {
    return { tail: "", text };
  }
  const closeIndex = text.indexOf("]]", openIndex + 2);
  if (closeIndex !== -1) {
    return { tail: "", text };
  }
  return {
    tail: text.slice(openIndex),
    text: text.slice(0, openIndex),
  };
};

const parseChunk = (raw: string, options?: { silentToken?: string }): ParsedChunk => {
  const split = splitMediaFromOutput(raw);
  let text = split.text ?? "";

  const replyParsed = parseInlineDirectives(text, {
    stripAudioTag: false,
    stripReplyTags: true,
  });

  if (replyParsed.hasReplyTag) {
    ({ text } = replyParsed);
  }

  const silentToken = options?.silentToken ?? SILENT_REPLY_TOKEN;
  const isSilent =
    isSilentReplyText(text, silentToken) || isSilentReplyPrefixText(text, silentToken);
  if (isSilent) {
    text = "";
  } else if (startsWithSilentToken(text, silentToken)) {
    text = stripLeadingSilentToken(text, silentToken);
  }

  return {
    audioAsVoice: split.audioAsVoice,
    isSilent,
    mediaUrl: split.mediaUrl,
    mediaUrls: split.mediaUrls,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToExplicitId: replyParsed.replyToExplicitId,
    replyToId: replyParsed.replyToId,
    replyToTag: replyParsed.hasReplyTag,
    text,
  };
};

const hasRenderableContent = (parsed: ReplyDirectiveParseResult): boolean =>
  hasOutboundReplyContent(parsed) || Boolean(parsed.audioAsVoice);

export function createStreamingDirectiveAccumulator() {
  let pendingTail = "";
  let pendingReply: PendingReplyState = { hasTag: false, sawCurrent: false };
  let activeReply: PendingReplyState = { hasTag: false, sawCurrent: false };

  const reset = () => {
    pendingTail = "";
    pendingReply = { hasTag: false, sawCurrent: false };
    activeReply = { hasTag: false, sawCurrent: false };
  };

  const consume = (raw: string, options: ConsumeOptions = {}): ReplyDirectiveParseResult | null => {
    let combined = `${pendingTail}${raw ?? ""}`;
    pendingTail = "";

    if (!options.final) {
      const split = splitTrailingDirective(combined);
      combined = split.text;
      pendingTail = split.tail;
    }

    if (!combined) {
      return null;
    }

    const parsed = parseChunk(combined, { silentToken: options.silentToken });
    const hasTag = activeReply.hasTag || pendingReply.hasTag || parsed.replyToTag;
    const sawCurrent = activeReply.sawCurrent || pendingReply.sawCurrent || parsed.replyToCurrent;
    const explicitId =
      parsed.replyToExplicitId ?? pendingReply.explicitId ?? activeReply.explicitId;

    const combinedResult: ReplyDirectiveParseResult = {
      ...parsed,
      replyToCurrent: sawCurrent,
      replyToId: explicitId,
      replyToTag: hasTag,
    };

    if (!hasRenderableContent(combinedResult)) {
      if (hasTag) {
        pendingReply = {
          explicitId,
          hasTag,
          sawCurrent,
        };
      }
      return null;
    }

    // Keep reply context sticky for the full assistant message so split/newline chunks
    // Stay on the same native reply target until reset() is called for the next message.
    activeReply = {
      explicitId,
      hasTag,
      sawCurrent,
    };
    pendingReply = { hasTag: false, sawCurrent: false };
    return combinedResult;
  };

  return {
    consume,
    reset,
  };
}
