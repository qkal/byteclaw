import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import type { ChannelPlugin, ResolvedLineAccount } from "./channel-api.js";
import { type LineOutboundMediaResolved, resolveLineOutboundMedia } from "./outbound-media.js";
import { getLineRuntime } from "./runtime.js";
import type { LineChannelData } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

type LineChannelDataWithMedia = LineChannelData & {
  mediaKind?: "image" | "video" | "audio";
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

function isLineUserTarget(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^line:(group|room|user):/i, "")
    .replace(/^line:/i, "");
  return /^U/i.test(normalized);
}

function hasLineSpecificMediaOptions(lineData: LineChannelDataWithMedia): boolean {
  return Boolean(
    lineData.mediaKind ??
    lineData.previewImageUrl?.trim() ??
    (typeof lineData.durationMs === "number" ? lineData.durationMs : undefined) ??
    lineData.trackingId?.trim(),
  );
}

function buildLineMediaMessageObject(
  resolved: LineOutboundMediaResolved,
  opts?: { allowTrackingId?: boolean },
): Record<string, unknown> {
  switch (resolved.mediaKind) {
    case "video": {
      const previewImageUrl = resolved.previewImageUrl?.trim();
      if (!previewImageUrl) {
        throw new Error("LINE video messages require previewImageUrl to reference an image URL");
      }
      return {
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl,
        type: "video",
        ...(opts?.allowTrackingId && resolved.trackingId
          ? { trackingId: resolved.trackingId }
          : {}),
      };
    }
    case "audio": {
      return {
        duration: resolved.durationMs ?? 60000,
        originalContentUrl: resolved.mediaUrl,
        type: "audio",
      };
    }
    default: {
      return {
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl: resolved.previewImageUrl ?? resolved.mediaUrl,
        type: "image",
      };
    }
  }
}

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  deliveryMode: "direct",
  sendPayload: async ({ to, payload, accountId, cfg }) => {
    const runtime = getLineRuntime();
    const outboundRuntime = await loadLineOutboundRuntime();
    const lineData = (payload.channelData?.line as LineChannelDataWithMedia | undefined) ?? {};
    const lineRuntime = runtime.channel.line;
    const sendText = lineRuntime?.pushMessageLine ?? outboundRuntime.pushMessageLine;
    const sendBatch = lineRuntime?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
    const sendFlex = lineRuntime?.pushFlexMessage ?? outboundRuntime.pushFlexMessage;
    const sendTemplate = lineRuntime?.pushTemplateMessage ?? outboundRuntime.pushTemplateMessage;
    const sendLocation = lineRuntime?.pushLocationMessage ?? outboundRuntime.pushLocationMessage;
    const sendQuickReplies =
      lineRuntime?.pushTextMessageWithQuickReplies ??
      outboundRuntime.pushTextMessageWithQuickReplies;
    const buildTemplate =
      lineRuntime?.buildTemplateMessageFromPayload ??
      outboundRuntime.buildTemplateMessageFromPayload;

    let lastResult: { messageId: string; chatId: string } | null = null;
    const quickReplies = lineData.quickReplies ?? [];
    const hasQuickReplies = quickReplies.length > 0;
    const quickReply = hasQuickReplies
      ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(quickReplies)
      : undefined;

    // LINE SDK expects Message[] but we build dynamically.
    const sendMessageBatch = async (messages: Record<string, unknown>[]) => {
      if (messages.length === 0) {
        return;
      }
      for (let i = 0; i < messages.length; i += 5) {
        const batch = messages.slice(i, i + 5) as unknown as Parameters<typeof sendBatch>[1];
        const result = await sendBatch(to, batch, {
          accountId: accountId ?? undefined,
          cfg,
          verbose: false,
        });
        lastResult = { chatId: result.chatId, messageId: result.messageId };
      }
    };

    const processed = payload.text
      ? outboundRuntime.processLineMessage(payload.text)
      : { flexMessages: [], text: "" };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;

    const chunks = processed.text
      ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
      : [];
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
    const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
    const sendMediaMessages = async () => {
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (!useLineSpecificMedia) {
          lastResult = await (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(
            to,
            "",
            {
              accountId: accountId ?? undefined,
              cfg,
              mediaUrl: trimmed,
              verbose: false,
            },
          );
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, {
          durationMs: lineData.durationMs,
          mediaKind: lineData.mediaKind,
          previewImageUrl: lineData.previewImageUrl,
          trackingId: lineData.trackingId,
        });
        lastResult = await (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(
          to,
          "",
          {
            accountId: accountId ?? undefined,
            cfg,
            durationMs: resolved.durationMs,
            mediaKind: resolved.mediaKind,
            mediaUrl: resolved.mediaUrl,
            previewImageUrl: resolved.previewImageUrl,
            trackingId: resolved.trackingId,
            verbose: false,
          },
        );
      }
    };

    if (!shouldSendQuickRepliesInline) {
      if (lineData.flexMessage) {
        const flexContents = lineData.flexMessage.contents as Parameters<typeof sendFlex>[2];
        lastResult = await sendFlex(to, lineData.flexMessage.altText, flexContents, {
          accountId: accountId ?? undefined,
          cfg,
          verbose: false,
        });
      }

      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          lastResult = await sendTemplate(to, template, {
            accountId: accountId ?? undefined,
            cfg,
            verbose: false,
          });
        }
      }

      if (lineData.location) {
        lastResult = await sendLocation(to, lineData.location, {
          accountId: accountId ?? undefined,
          cfg,
          verbose: false,
        });
      }

      for (const flexMsg of processed.flexMessages) {
        const flexContents = flexMsg.contents;
        lastResult = await sendFlex(to, flexMsg.altText, flexContents, {
          accountId: accountId ?? undefined,
          cfg,
          verbose: false,
        });
      }
    }

    const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (chunks.length > 0) {
      for (let i = 0; i < chunks.length; i += 1) {
        const isLast = i === chunks.length - 1;
        if (isLast && hasQuickReplies) {
          lastResult = await sendQuickReplies(to, chunks[i], quickReplies, {
            accountId: accountId ?? undefined,
            cfg,
            verbose: false,
          });
        } else {
          lastResult = await sendText(to, chunks[i], {
            accountId: accountId ?? undefined,
            cfg,
            verbose: false,
          });
        }
      }
    } else if (shouldSendQuickRepliesInline) {
      const quickReplyMessages: Record<string, unknown>[] = [];
      if (lineData.flexMessage) {
        quickReplyMessages.push({
          altText: lineData.flexMessage.altText.slice(0, 400),
          contents: lineData.flexMessage.contents,
          type: "flex",
        });
      }
      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          quickReplyMessages.push(template);
        }
      }
      if (lineData.location) {
        quickReplyMessages.push({
          address: lineData.location.address.slice(0, 100),
          latitude: lineData.location.latitude,
          longitude: lineData.location.longitude,
          title: lineData.location.title.slice(0, 100),
          type: "location",
        });
      }
      for (const flexMsg of processed.flexMessages) {
        quickReplyMessages.push({
          altText: flexMsg.altText.slice(0, 400),
          contents: flexMsg.contents,
          type: "flex",
        });
      }
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (!useLineSpecificMedia) {
          quickReplyMessages.push({
            originalContentUrl: trimmed,
            previewImageUrl: trimmed,
            type: "image",
          });
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, {
          durationMs: lineData.durationMs,
          mediaKind: lineData.mediaKind,
          previewImageUrl: lineData.previewImageUrl,
          trackingId: lineData.trackingId,
        });
        quickReplyMessages.push(
          buildLineMediaMessageObject(resolved, { allowTrackingId: isLineUserTarget(to) }),
        );
      }
      if (quickReplyMessages.length > 0 && quickReply) {
        const lastIndex = quickReplyMessages.length - 1;
        quickReplyMessages[lastIndex] = {
          ...quickReplyMessages[lastIndex],
          quickReply,
        };
        await sendMessageBatch(quickReplyMessages);
      }
    }

    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (lastResult) {
      return createEmptyChannelResult("line", { ...lastResult });
    }
    return createEmptyChannelResult("line", { chatId: to, messageId: "empty" });
  },
  textChunkLimit: 5000,
  ...createAttachedChannelResultAdapter({
    channel: "line",
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) =>
      await (
        await loadLineOutboundRuntime()
      ).sendMessageLine(to, text, {
        accountId: accountId ?? undefined,
        cfg,
        mediaUrl,
        verbose: false,
      }),
    sendText: async ({ cfg, to, text, accountId }) => {
      const outboundRuntime = await loadLineOutboundRuntime();
      const sendText = outboundRuntime.pushMessageLine;
      const sendFlex = outboundRuntime.pushFlexMessage;
      const processed = outboundRuntime.processLineMessage(text);
      let result: { messageId: string; chatId: string };
      if (processed.text.trim()) {
        result = await sendText(to, processed.text, {
          accountId: accountId ?? undefined,
          cfg,
          verbose: false,
        });
      } else {
        result = { chatId: to, messageId: "processed" };
      }
      for (const flexMsg of processed.flexMessages) {
        const flexContents = flexMsg.contents;
        await sendFlex(to, flexMsg.altText, flexContents, {
          accountId: accountId ?? undefined,
          cfg,
          verbose: false,
        });
      }
      return result;
    },
  }),
};
