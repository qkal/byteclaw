import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { type QaBusMessage, buildQaTarget, sendQaBusMessage } from "./bus-client.js";
import { getQaChannelRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export async function handleQaInbound(params: {
  channelId: string;
  channelLabel: string;
  account: ResolvedQaChannelAccount;
  config: CoreConfig;
  message: QaBusMessage;
}) {
  const runtime = getQaChannelRuntime();
  const inbound = params.message;
  const target = buildQaTarget({
    chatType: inbound.conversation.kind,
    conversationId: inbound.conversation.id,
    threadId: inbound.threadId,
  });
  const route = runtime.channel.routing.resolveAgentRoute({
    accountId: params.account.accountId,
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    peer: {
      id: target,
      kind: inbound.conversation.kind === "direct" ? "direct" : "channel",
    },
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    sessionKey: route.sessionKey,
    storePath,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    body: inbound.text,
    channel: params.channelLabel,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    from: inbound.senderName || inbound.senderId,
    previousTimestamp,
    timestamp: inbound.timestamp,
  });

  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    AccountId: route.accountId ?? params.account.accountId,
    Body: body,
    BodyForAgent: inbound.text,
    ChatType: inbound.conversation.kind === "direct" ? "direct" : "group",
    CommandAuthorized: true,
    CommandBody: inbound.text,
    ConversationLabel:
      inbound.threadTitle ||
      inbound.conversation.title ||
      inbound.senderName ||
      inbound.conversation.id,
    From: buildQaTarget({
      chatType: inbound.conversation.kind,
      conversationId: inbound.senderId,
    }),
    GroupChannel: inbound.conversation.kind === "channel" ? inbound.conversation.id : undefined,
    GroupSubject:
      inbound.conversation.kind === "channel"
        ? inbound.threadTitle || inbound.conversation.title || inbound.conversation.id
        : undefined,
    MessageSid: inbound.id,
    MessageSidFull: inbound.id,
    MessageThreadId: inbound.threadId,
    NativeChannelId: inbound.conversation.id,
    OriginatingChannel: params.channelId,
    OriginatingTo: target,
    Provider: params.channelId,
    RawBody: inbound.text,
    ReplyToId: inbound.replyToId,
    SenderId: inbound.senderId,
    SenderName: inbound.senderName,
    SessionKey: route.sessionKey,
    Surface: params.channelId,
    ThreadLabel: inbound.threadTitle,
    ThreadParentId: inbound.threadId ? inbound.conversation.id : undefined,
    Timestamp: inbound.timestamp,
    To: target,
  });

  await dispatchInboundReplyWithBase({
    accountId: params.account.accountId,
    cfg: params.config as OpenClawConfig,
    channel: params.channelId,
    core: runtime,
    ctxPayload,
    deliver: async (payload) => {
      const text =
        payload && typeof payload === "object" && "text" in payload
          ? String((payload as { text?: string }).text ?? "")
          : "";
      if (!text.trim()) {
        return;
      }
      await sendQaBusMessage({
        accountId: params.account.accountId,
        baseUrl: params.account.baseUrl,
        replyToId: inbound.id,
        senderId: params.account.botUserId,
        senderName: params.account.botDisplayName,
        text,
        threadId: inbound.threadId,
        to: target,
      });
    },
    onDispatchError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`qa-channel dispatch failed: ${String(error)}`);
    },
    onRecordError: (error) => {
      throw error instanceof Error
        ? error
        : new Error(`qa-channel session record failed: ${String(error)}`);
    },
    route,
    storePath,
  });
}
