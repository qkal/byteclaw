import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import { normalizeE164 } from "../../text-runtime.js";
import { loadConfig } from "../config.runtime.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import type { EchoTracker } from "./echo.js";
import type { GroupHistoryEntry } from "./group-gating.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";

export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  echoTracker: EchoTracker;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("openclaw/plugin-sdk/runtime-env"))["getChildLogger"]>;
  baseMentionConfig: MentionConfig;
  account: { authDir?: string; accountId?: string; selfChatMode?: boolean };
}) {
  const processForRoute = async (
    msg: WebInboundMsg,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
    },
  ) =>
    processMessage({
      backgroundTasks: params.backgroundTasks,
      buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
      cfg: params.cfg,
      connectionId: params.connectionId,
      echoForget: params.echoTracker.forget,
      echoHas: params.echoTracker.has,
      groupHistories: params.groupHistories,
      groupHistory: opts?.groupHistory,
      groupHistoryKey,
      groupMemberNames: params.groupMemberNames,
      maxMediaBytes: params.maxMediaBytes,
      msg,
      rememberSentText: params.echoTracker.rememberText,
      replyLogger: params.replyLogger,
      replyResolver: params.replyResolver,
      route,
      suppressGroupHistoryClear: opts?.suppressGroupHistoryClear,
      verbose: params.verbose,
    });

  return async (msg: WebInboundMsg) => {
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    // Fresh config for bindings lookup; other routing inputs are payload-derived.
    const route = resolveAgentRoute({
      accountId: msg.accountId,
      cfg: loadConfig(),
      channel: "whatsapp",
      peer: {
        id: peerId,
        kind: msg.chatType === "group" ? "group" : "direct",
      },
    });
    const groupHistoryKey =
      msg.chatType === "group"
        ? buildGroupHistoryKey({
            accountId: route.accountId,
            channel: "whatsapp",
            peerId,
            peerKind: "group",
          })
        : route.sessionKey;

    // Same-phone mode logging retained
    if (msg.from === msg.to) {
      logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
    }

    // Skip if this is a message we just sent (echo detection)
    if (params.echoTracker.has(msg.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.body);
      return;
    }

    if (msg.chatType === "group") {
      const sender = getSenderIdentity(msg);
      const metaCtx = {
        AccountId: route.accountId,
        ChatType: msg.chatType,
        ConversationLabel: conversationId,
        From: msg.from,
        GroupSubject: msg.groupSubject,
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
        Provider: "whatsapp",
        SenderE164: sender.e164 ?? undefined,
        SenderId: getPrimaryIdentityId(sender) ?? undefined,
        SenderName: sender.name ?? undefined,
        SessionKey: route.sessionKey,
        Surface: "whatsapp",
        To: msg.to,
      } satisfies MsgContext;
      updateLastRouteInBackground({
        accountId: route.accountId,
        backgroundTasks: params.backgroundTasks,
        cfg: params.cfg,
        channel: "whatsapp",
        ctx: metaCtx,
        sessionKey: route.sessionKey,
        storeAgentId: route.agentId,
        to: conversationId,
        warn: params.replyLogger.warn.bind(params.replyLogger),
      });

      const gating = applyGroupGating({
        agentId: route.agentId,
        authDir: params.account.authDir,
        baseMentionConfig: params.baseMentionConfig,
        cfg: params.cfg,
        conversationId,
        groupHistories: params.groupHistories,
        groupHistoryKey,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        msg,
        replyLogger: params.replyLogger,
        selfChatMode: params.account.selfChatMode,
        sessionKey: route.sessionKey,
      });
      if (!gating.shouldProcess) {
        return;
      }
    } else {
      // Ensure `peerId` for DMs is stable and stored as E.164 when possible.
      if (!msg.sender?.e164 && !msg.senderE164 && peerId && peerId.startsWith("+")) {
        const normalized = normalizeE164(peerId);
        if (normalized) {
          msg.sender = { ...msg.sender, e164: normalized };
          msg.senderE164 = normalized;
        }
      }
    }

    // Broadcast groups: when we'd reply anyway, run multiple agents.
    // Does not bypass group mention/activation gating above.
    if (
      await maybeBroadcastMessage({
        cfg: params.cfg,
        groupHistories: params.groupHistories,
        groupHistoryKey,
        msg,
        peerId,
        processMessage: processForRoute,
        route,
      })
    ) {
      return;
    }

    await processForRoute(msg, route, groupHistoryKey);
  };
}
