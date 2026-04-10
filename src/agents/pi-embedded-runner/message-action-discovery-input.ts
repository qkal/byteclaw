import type { OpenClawConfig } from "../../config/config.js";

export function buildEmbeddedMessageActionDiscoveryInput(params: {
  cfg?: OpenClawConfig;
  channel: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  senderId?: string | null;
}) {
  return {
    accountId: params.accountId ?? undefined,
    agentId: params.agentId ?? undefined,
    cfg: params.cfg,
    channel: params.channel,
    currentChannelId: params.currentChannelId ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    requesterSenderId: params.senderId ?? undefined,
    sessionId: params.sessionId ?? undefined,
    sessionKey: params.sessionKey ?? undefined,
  };
}
