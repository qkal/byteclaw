import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { sendMessage } from "./client.js";
import { type SynologyInboundMessage, buildSynologyChatInboundContext } from "./inbound-context.js";
import { getSynologyRuntime } from "./runtime.js";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

interface SynologyChannelLog {
  info?: (...args: unknown[]) => void;
}

function resolveSynologyChatInboundRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  userId: string;
}) {
  const rt = getSynologyRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    accountId: params.account.accountId,
    cfg: params.cfg,
    channel: CHANNEL_ID,
    peer: {
      id: params.userId,
      kind: "direct",
    },
  });
  return {
    route,
    rt,
    sessionKey: buildSynologyChatInboundSessionKey({
      accountId: params.account.accountId,
      agentId: route.agentId,
      identityLinks: params.cfg.session?.identityLinks,
      userId: params.userId,
    }),
  };
}

async function deliverSynologyChatReply(params: {
  account: ResolvedSynologyChatAccount;
  sendUserId: string;
  payload: { text?: string; body?: string };
}): Promise<void> {
  const text = params.payload.text ?? params.payload.body;
  if (!text) {
    return;
  }
  await sendMessage(
    params.account.incomingUrl,
    text,
    params.sendUserId,
    params.account.allowInsecureSsl,
  );
}

export async function dispatchSynologyChatInboundTurn(params: {
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  log?: SynologyChannelLog;
}): Promise<null> {
  const rt = getSynologyRuntime();
  const currentCfg = rt.config.loadConfig();

  // The Chat API user_id (for sending) may differ from the webhook
  // User_id (used for sessions/pairing). Use chatUserId for API calls.
  const sendUserId = params.msg.chatUserId ?? params.msg.from;
  const resolved = resolveSynologyChatInboundRoute({
    account: params.account,
    cfg: currentCfg,
    userId: params.msg.from,
  });
  const msgCtx = buildSynologyChatInboundContext({
    account: params.account,
    finalizeInboundContext: resolved.rt.channel.reply.finalizeInboundContext,
    msg: params.msg,
    sessionKey: resolved.sessionKey,
  });

  await resolved.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    cfg: currentCfg,
    ctx: msgCtx,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; body?: string }) => {
        await deliverSynologyChatReply({
          account: params.account,
          payload,
          sendUserId,
        });
      },
      onReplyStart: () => {
        params.log?.info?.(`Agent reply started for ${params.msg.from}`);
      },
    },
  });

  return null;
}
