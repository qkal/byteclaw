import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

export interface SynologyInboundMessage {
  body: string;
  from: string;
  senderName: string;
  provider: string;
  chatType: string;
  accountId: string;
  commandAuthorized: boolean;
  chatUserId?: string;
}

export function buildSynologyChatInboundContext<TContext>(params: {
  finalizeInboundContext: (ctx: Record<string, unknown>) => TContext;
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  sessionKey: string;
}): TContext {
  const { account, msg, sessionKey } = params;
  return params.finalizeInboundContext({
    AccountId: account.accountId,
    Body: msg.body,
    ChatType: msg.chatType,
    CommandAuthorized: msg.commandAuthorized,
    CommandBody: msg.body,
    ConversationLabel: msg.senderName || msg.from,
    From: `synology-chat:${msg.from}`,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `synology-chat:${msg.from}`,
    Provider: CHANNEL_ID,
    RawBody: msg.body,
    SenderId: msg.from,
    SenderName: msg.senderName,
    SessionKey: sessionKey,
    Surface: CHANNEL_ID,
    Timestamp: Date.now(),
    To: `synology-chat:${msg.from}`,
  });
}
