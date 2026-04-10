import { normalizeConversationText } from "../../acp/conversation-id.js";
import { resolveConversationBindingContext } from "../../channels/conversation-binding-context.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";

type BindingMsgContext = Pick<
  MsgContext,
  | "OriginatingChannel"
  | "Surface"
  | "Provider"
  | "AccountId"
  | "ChatType"
  | "MessageThreadId"
  | "ThreadParentId"
  | "SenderId"
  | "SessionKey"
  | "ParentSessionKey"
  | "OriginatingTo"
  | "To"
  | "From"
  | "NativeChannelId"
>;

function resolveBindingChannel(ctx: BindingMsgContext, commandChannel?: string | null): string {
  const raw = ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider;
  return normalizeLowercaseStringOrEmpty(normalizeConversationText(raw));
}

function resolveBindingAccountId(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  const channel = resolveBindingChannel(params.ctx, params.commandChannel);
  const plugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  const accountId = normalizeConversationText(params.ctx.AccountId);
  return (
    accountId ||
    normalizeConversationText(plugin?.config.defaultAccountId?.(params.cfg)) ||
    "default"
  );
}

function resolveBindingThreadId(threadId: string | number | null | undefined): string | undefined {
  const normalized = threadId != null ? normalizeConversationText(String(threadId)) : undefined;
  return normalized || undefined;
}

export function resolveConversationBindingContextFromMessage(params: {
  cfg: OpenClawConfig;
  ctx: BindingMsgContext;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  commandTo?: string | null;
}): ReturnType<typeof resolveConversationBindingContext> {
  const channel = resolveBindingChannel(params.ctx);
  return resolveConversationBindingContext({
    accountId: resolveBindingAccountId({
      cfg: params.cfg,
      commandChannel: channel,
      ctx: params.ctx,
    }),
    cfg: params.cfg,
    channel,
    chatType: params.ctx.ChatType,
    commandTo: params.commandTo,
    fallbackTo: params.ctx.To,
    from: params.ctx.From,
    nativeChannelId: params.ctx.NativeChannelId,
    originatingTo: params.ctx.OriginatingTo,
    parentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
    senderId: params.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
    threadId: resolveBindingThreadId(params.ctx.MessageThreadId),
    threadParentId: params.ctx.ThreadParentId,
  });
}

export function resolveConversationBindingContextFromAcpCommand(
  params: HandleCommandsParams,
): ReturnType<typeof resolveConversationBindingContext> {
  return resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    commandTo: params.command.to,
    ctx: params.ctx,
    parentSessionKey: params.ctx.ParentSessionKey,
    senderId: params.command.senderId,
    sessionKey: params.sessionKey,
  });
}

export function resolveConversationBindingChannelFromMessage(
  ctx: BindingMsgContext,
  commandChannel?: string | null,
): string {
  return resolveBindingChannel(ctx, commandChannel);
}

export function resolveConversationBindingAccountIdFromMessage(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  return resolveBindingAccountId(params);
}

export function resolveConversationBindingThreadIdFromMessage(
  ctx: Pick<BindingMsgContext, "MessageThreadId">,
): string | undefined {
  return resolveBindingThreadId(ctx.MessageThreadId);
}
