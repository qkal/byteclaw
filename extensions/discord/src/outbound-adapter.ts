import {
  type ChannelOutboundAdapter,
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type OutboundIdentity,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import type { DiscordComponentMessageSpec } from "./components.js";
import { type ThreadBindingRecord, getThreadBindingManager } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { sendDiscordComponentMessage } from "./send.components.js";
import { sendMessageDiscord, sendPollDiscord, sendWebhookMessageDiscord } from "./send.js";
import { buildDiscordInteractiveComponents } from "./shared-interactive.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

function hasApprovalChannelData(payload: { channelData?: unknown }): boolean {
  const { channelData } = payload;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }
  return Boolean((channelData as { execApproval?: unknown }).execApproval);
}

function neutralizeDiscordApprovalMentions(value: string): string {
  return value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b");
}

function normalizeDiscordApprovalPayload<T extends { text?: string; channelData?: unknown }>(
  payload: T,
): T {
  return hasApprovalChannelData(payload) && payload.text
    ? {
        ...payload,
        text: neutralizeDiscordApprovalMentions(payload.text),
      }
    : payload;
}

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = normalizeOptionalString(params.identity?.name);
  const fallbackUsername = normalizeOptionalString(params.binding.label) ?? params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = normalizeOptionalString(params.identity?.avatarUrl);
  return { avatarUrl, username };
}

async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    binding,
    identity: params.identity,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    accountId: binding.accountId,
    avatarUrl: persona.avatarUrl,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    threadId: binding.threadId,
    username: persona.username,
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  chunker: null,
  deliveryMode: "direct",
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  pollMaxOptions: 10,
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => {
    const payload = normalizeDiscordApprovalPayload({
      ...ctx.payload,
      text: ctx.payload.text ?? "",
    });
    const discordData = payload.channelData?.discord as
      | { components?: DiscordComponentMessageSpec }
      | undefined;
    const rawComponentSpec =
      discordData?.components ?? buildDiscordInteractiveComponents(payload.interactive);
    const componentSpec = rawComponentSpec
      ? rawComponentSpec.text
        ? rawComponentSpec
        : {
            ...rawComponentSpec,
            text: payload.text?.trim() ? payload.text : undefined,
          }
      : undefined;
    if (!componentSpec) {
      return await sendTextMediaPayload({
        adapter: discordOutbound,
        channel: "discord",
        ctx: {
          ...ctx,
          payload,
        },
      });
    }
    const send =
      resolveOutboundSendDep<typeof sendMessageDiscord>(ctx.deps, "discord") ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ threadId: ctx.threadId, to: ctx.to });
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const result = await sendPayloadMediaSequenceOrFallback({
      fallbackResult: { channelId: target, messageId: "" },
      mediaUrls,
      send: async ({ text, mediaUrl, isFirst }) => {
        if (isFirst) {
          return await sendDiscordComponentMessage(target, componentSpec, {
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: ctx.replyToId ?? undefined,
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
          });
        }
        return await send(target, text, {
          verbose: false,
          mediaUrl,
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        });
      },
      sendNoMedia: async () =>
        await sendDiscordComponentMessage(target, componentSpec, {
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        }),
      text: payload.text ?? "",
    });
    return attachChannelToResult("discord", result);
  },
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
    }) => {
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ threadId, to }), text, {
        accountId: accountId ?? undefined,
        cfg,
        mediaLocalRoots,
        mediaReadFile,
        mediaUrl,
        replyTo: replyToId ?? undefined,
        silent: silent ?? undefined,
        verbose: false,
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
      await sendPollDiscord(resolveDiscordOutboundTarget({ threadId, to }), poll, {
        accountId: accountId ?? undefined,
        cfg,
        silent: silent ?? undefined,
      }),
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
      if (!silent) {
        const webhookResult = await maybeSendDiscordWebhookText({
          accountId,
          cfg,
          identity,
          replyToId,
          text,
          threadId,
        }).catch(() => null);
        if (webhookResult) {
          return webhookResult;
        }
      }
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ threadId, to }), text, {
        accountId: accountId ?? undefined,
        cfg,
        replyTo: replyToId ?? undefined,
        silent: silent ?? undefined,
        verbose: false,
      });
    },
  }),
};
