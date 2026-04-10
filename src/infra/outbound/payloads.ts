import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  type InteractiveReply,
  hasInteractiveReplyBlocks,
  hasReplyChannelData,
  hasReplyPayloadContent,
} from "../../interactive/payload.js";

export interface NormalizedOutboundPayload {
  text: string;
  mediaUrls: string[];
  audioAsVoice?: boolean;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
}

export interface OutboundPayloadJson {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
}

function mergeMediaUrls(...lists: (readonly (string | undefined)[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const entry of list) {
      const trimmed = entry?.trim();
      if (!trimmed) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

export function normalizeReplyPayloadsForDelivery(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  const normalized: ReplyPayload[] = [];
  for (const payload of payloads) {
    if (shouldSuppressReasoningPayload(payload)) {
      continue;
    }
    const parsed = parseReplyDirectives(payload.text ?? "");
    const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
    const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
    const mergedMedia = mergeMediaUrls(
      explicitMediaUrls,
      explicitMediaUrl ? [explicitMediaUrl] : undefined,
    );
    const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
    const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
    const next: ReplyPayload = {
      ...payload,
      audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
      mediaUrl: resolvedMediaUrl,
      mediaUrls: mergedMedia.length ? mergedMedia : undefined,
      replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
      replyToId: payload.replyToId ?? parsed.replyToId,
      replyToTag: payload.replyToTag || parsed.replyToTag,
      text:
        formatBtwTextForExternalDelivery({
          ...payload,
          text: parsed.text ?? "",
        }) ?? "",
    };
    if (parsed.isSilent && mergedMedia.length === 0) {
      continue;
    }
    if (!isRenderablePayload(next)) {
      continue;
    }
    normalized.push(next);
  }
  return normalized;
}

export function normalizeOutboundPayloads(
  payloads: readonly ReplyPayload[],
): NormalizedOutboundPayload[] {
  const normalizedPayloads: NormalizedOutboundPayload[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    const parts = resolveSendableOutboundReplyParts(payload);
    const { interactive } = payload;
    const { channelData } = payload;
    const hasChannelData = hasReplyChannelData(channelData);
    const hasInteractive = hasInteractiveReplyBlocks(interactive);
    const { text } = parts;
    if (
      !hasReplyPayloadContent({ ...payload, mediaUrls: parts.mediaUrls, text }, { hasChannelData })
    ) {
      continue;
    }
    normalizedPayloads.push({
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      mediaUrls: parts.mediaUrls,
      text,
      ...(hasInteractive ? { interactive } : {}),
      ...(hasChannelData ? { channelData } : {}),
    });
  }
  return normalizedPayloads;
}

export function normalizeOutboundPayloadsForJson(
  payloads: readonly ReplyPayload[],
): OutboundPayloadJson[] {
  const normalized: OutboundPayloadJson[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    const parts = resolveSendableOutboundReplyParts(payload);
    normalized.push({
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      channelData: payload.channelData,
      interactive: payload.interactive,
      mediaUrl: payload.mediaUrl ?? null,
      mediaUrls: parts.mediaUrls.length ? parts.mediaUrls : undefined,
      text: parts.text,
    });
  }
  return normalized;
}

export function formatOutboundPayloadLog(
  payload: Pick<NormalizedOutboundPayload, "text" | "channelData"> & {
    mediaUrls: readonly string[];
  },
): string {
  const lines: string[] = [];
  if (payload.text) {
    lines.push(payload.text.trimEnd());
  }
  for (const url of payload.mediaUrls) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n");
}
