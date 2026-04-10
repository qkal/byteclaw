import { resolveWhatsAppAccount } from "../../accounts.js";
import { getPrimaryIdentityId, getSelfIdentity, getSenderIdentity } from "../../identity.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import {
  type GroupHistoryEntry,
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";
import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
import {
  type HistoryEntry,
  type LoadConfigFn,
  buildHistoryContextFromEntries,
  createChannelReplyPipeline,
  formatInboundEnvelope,
  type getChildLogger,
  type getReplyFromConfig,
  logVerbose,
  normalizeE164,
  readStoreAllowFromForDmPolicy,
  recordSessionMetaFromInbound,
  type resolveAgentRoute,
  resolveChannelContextVisibilityMode,
  resolveDmGroupAccessWithCommandGate,
  resolveInboundSessionEnvelopeContext,
  resolvePinnedMainDmOwnerFromAllowlist,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
} from "./runtime-api.js";

async function resolveWhatsAppCommandAuthorized(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMsg;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }

  const isGroup = params.msg.chatType === "group";
  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg);
  const senderE164 = normalizeE164(
    isGroup ? (sender.e164 ?? "") : (sender.e164 ?? params.msg.from ?? ""),
  );
  if (!senderE164) {
    return false;
  }

  const account = resolveWhatsAppAccount({ accountId: params.msg.accountId, cfg: params.cfg });
  const dmPolicy = account.dmPolicy ?? "pairing";
  const groupPolicy = account.groupPolicy ?? "allowlist";
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);

  const storeAllowFrom = isGroup
    ? []
    : await readStoreAllowFromForDmPolicy({
        accountId: params.msg.accountId,
        dmPolicy,
        provider: "whatsapp",
      });
  const dmAllowFrom =
    configuredAllowFrom.length > 0 ? configuredAllowFrom : (self.e164 ? [self.e164] : []);
  const access = resolveDmGroupAccessWithCommandGate({
    allowFrom: dmAllowFrom,
    command: {
      allowTextCommands: true,
      hasControlCommand: true,
      useAccessGroups,
    },
    dmPolicy,
    groupAllowFrom: configuredGroupAllowFrom,
    groupPolicy,
    isGroup,
    isSenderAllowed: (allowEntries) => {
      if (allowEntries.includes("*")) {
        return true;
      }
      const normalizedEntries = allowEntries
        .map((entry) => normalizeE164(String(entry)))
        .filter((entry): entry is string => Boolean(entry));
      return normalizedEntries.includes(senderE164);
    },
    storeAllowFrom,
  });
  return access.commandAuthorized;
}

function resolvePinnedMainDmRecipient(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMsg;
}): string | null {
  const account = resolveWhatsAppAccount({ accountId: params.msg.accountId, cfg: params.cfg });
  return resolvePinnedMainDmOwnerFromAllowlist({
    allowFrom: account.allowFrom,
    dmScope: params.cfg.session?.dmScope,
    normalizeEntry: (entry) => normalizeE164(entry),
  });
}

export async function processMessage(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  connectionId: string;
  verbose: boolean;
  maxMediaBytes: number;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<typeof getChildLogger>;
  backgroundTasks: Set<Promise<unknown>>;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  echoHas: (key: string) => boolean;
  echoForget: (key: string) => void;
  buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) => string;
  maxMediaTextChunkLimit?: number;
  groupHistory?: GroupHistoryEntry[];
  suppressGroupHistoryClear?: boolean;
}) {
  const conversationId = params.msg.conversationId ?? params.msg.from;
  const account = resolveWhatsAppAccount({
    accountId: params.route.accountId ?? params.msg.accountId,
    cfg: params.cfg,
  });
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    accountId: account.accountId,
    cfg: params.cfg,
    channel: "whatsapp",
  });
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);
  const groupAllowFrom = configuredGroupAllowFrom ?? [];
  const groupPolicy = account.groupPolicy ?? "allowlist";
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    agentId: params.route.agentId,
    cfg: params.cfg,
    sessionKey: params.route.sessionKey,
  });
  let combinedBody = buildInboundLine({
    agentId: params.route.agentId,
    cfg: params.cfg,
    envelope: envelopeOptions,
    msg: params.msg,
    previousTimestamp,
  });
  let shouldClearGroupHistory = false;
  const visibleGroupHistory =
    params.msg.chatType === "group"
      ? resolveVisibleWhatsAppGroupHistory({
          groupAllowFrom,
          groupPolicy,
          history: params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [],
          mode: contextVisibilityMode,
        })
      : undefined;

  if (params.msg.chatType === "group") {
    const history = visibleGroupHistory ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        body: m.body,
        sender: m.sender,
        timestamp: m.timestamp,
      }));
      combinedBody = buildHistoryContextFromEntries({
        currentMessage: combinedBody,
        entries: historyEntries,
        excludeLast: false,
        formatEntry: (entry) => formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }

  // Echo detection uses combined body so we don't respond twice.
  const combinedEchoKey = params.buildCombinedEchoKey({
    combinedBody,
    sessionKey: params.route.sessionKey,
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }

  // Send ack reaction immediately upon message receipt (post-gating)
  maybeSendAckReaction({
    accountId: params.route.accountId,
    agentId: params.route.agentId,
    cfg: params.cfg,
    conversationId,
    info: params.replyLogger.info.bind(params.replyLogger),
    msg: params.msg,
    sessionKey: params.route.sessionKey,
    verbose: params.verbose,
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const correlationId = params.msg.id ?? newConnectionId();
  params.replyLogger.info(
    {
      body: elide(combinedBody, 240),
      connectionId: params.connectionId,
      correlationId,
      from: params.msg.chatType === "group" ? conversationId : params.msg.from,
      mediaPath: params.msg.mediaPath ?? null,
      mediaType: params.msg.mediaType ?? null,
      to: params.msg.to,
    },
    "inbound web message",
  );

  const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
  const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const sender = getSenderIdentity(params.msg);
  const self = getSelfIdentity(params.msg);
  const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
    authDir: account.authDir,
    groupAllowFrom,
    groupPolicy,
    mode: contextVisibilityMode,
    msg: params.msg,
  });
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    normalizeE164,
    senderE164: sender.e164 ?? undefined,
  });
  const commandAuthorized = shouldComputeCommandAuthorized(params.msg.body, params.cfg)
    ? await resolveWhatsAppCommandAuthorized({ cfg: params.cfg, msg: params.msg })
    : undefined;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: params.route.accountId,
    agentId: params.route.agentId,
    cfg: params.cfg,
    channel: "whatsapp",
  });
  const isSelfChat =
    params.msg.chatType !== "group" &&
    Boolean(self.e164) &&
    normalizeE164(params.msg.from) === normalizeE164(self.e164 ?? "");
  const responsePrefix = resolveWhatsAppResponsePrefix({
    agentId: params.route.agentId,
    cfg: params.cfg,
    isSelfChat,
    pipelineResponsePrefix: replyPipeline.responsePrefix,
  });

  const ctxPayload = buildWhatsAppInboundContext({
    combinedBody,
    commandAuthorized,
    conversationId,
    groupHistory: visibleGroupHistory,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    msg: params.msg,
    route: params.route,
    sender: {
      e164: sender.e164 ?? undefined,
      id: getPrimaryIdentityId(sender) ?? undefined,
      name: sender.name ?? undefined,
    },
    visibleReplyTo: visibleReplyTo ?? undefined,
  });

  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    msg: params.msg,
  });
  updateWhatsAppMainLastRoute({
    backgroundTasks: params.backgroundTasks,
    cfg: params.cfg,
    ctx: ctxPayload,
    dmRouteTarget,
    pinnedMainDmRecipient,
    route: params.route,
    updateLastRoute: updateLastRouteInBackground,
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const metaTask = recordSessionMetaFromInbound({
    ctx: ctxPayload,
    sessionKey: params.route.sessionKey,
    storePath,
  }).catch((error) => {
    params.replyLogger.warn(
      {
        error: formatError(error),
        sessionKey: params.route.sessionKey,
        storePath,
      },
      "failed updating session meta",
    );
  });
  trackBackgroundTask(params.backgroundTasks, metaTask);

  return dispatchWhatsAppBufferedReply({
    cfg: params.cfg,
    connectionId: params.connectionId,
    context: ctxPayload,
    conversationId,
    deliverReply: deliverWebReply,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    maxMediaBytes: params.maxMediaBytes,
    maxMediaTextChunkLimit: params.maxMediaTextChunkLimit,
    msg: params.msg,
    onModelSelected,
    rememberSentText: params.rememberSentText,
    replyLogger: params.replyLogger,
    replyPipeline: {
      ...replyPipeline,
      responsePrefix,
    },
    replyResolver: params.replyResolver,
    route: params.route,
    shouldClearGroupHistory,
  });
}
