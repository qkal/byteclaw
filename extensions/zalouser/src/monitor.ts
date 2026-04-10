import { mergeAllowlist, summarizeMapping } from "openclaw/plugin-sdk/allow-from";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveSenderCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
import {
  type MarkdownTableMode,
  type OpenClawConfig,
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "openclaw/plugin-sdk/group-access";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import {
  type OutboundReplyPayload,
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  buildZalouserGroupCandidates,
  findZalouserGroupEntry,
  isZalouserGroupEntryAllowed,
} from "./group-policy.js";
import { formatZalouserMessageSidFull, resolveZalouserMessageSid } from "./message-sid.js";
import { getZalouserRuntime } from "./runtime.js";
import {
  sendDeliveredZalouser,
  sendMessageZalouser,
  sendSeenZalouser,
  sendTypingZalouser,
} from "./send.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import {
  listZaloFriends,
  listZaloGroups,
  resolveZaloGroupContext,
  startZaloListener,
} from "./zalo-js.js";

export interface ZalouserMonitorOptions {
  account: ResolvedZalouserAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

export interface ZalouserMonitorResult {
  stop: () => void;
}

const ZALOUSER_TEXT_LIMIT = 2000;

function normalizeZalouserEntry(entry: string): string {
  return entry.replace(/^(zalouser|zlu):/i, "").trim();
}

function buildNameIndex<T>(items: T[], nameFn: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = normalizeOptionalLowercaseString(nameFn(item));
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}

function resolveUserAllowlistEntries(
  entries: string[],
  byName: Map<string, { userId: string }[]>,
): {
  additions: string[];
  mapping: string[];
  unresolved: string[];
} {
  const additions: string[] = [];
  const mapping: string[] = [];
  const unresolved: string[] = [];
  for (const entry of entries) {
    if (/^\d+$/.test(entry)) {
      additions.push(entry);
      continue;
    }
    const matches = byName.get(normalizeLowercaseStringOrEmpty(entry)) ?? [];
    const match = matches[0];
    const id = match?.userId ? String(match.userId) : undefined;
    if (id) {
      additions.push(id);
      mapping.push(`${entry}->${id}`);
    } else {
      unresolved.push(entry);
    }
  }
  return { additions, mapping, unresolved };
}

type ZalouserCoreRuntime = ReturnType<typeof getZalouserRuntime>;

interface ZalouserGroupHistoryState {
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
}

function resolveInboundQueueKey(message: ZaloInboundMessage): string {
  const threadId = message.threadId?.trim() || "unknown";
  if (message.isGroup) {
    return `group:${threadId}`;
  }
  const senderId = message.senderId?.trim();
  return `direct:${senderId || threadId}`;
}

function resolveZalouserDmSessionScope(config: OpenClawConfig) {
  const configured = config.session?.dmScope;
  return configured === "main" || !configured ? "per-channel-peer" : configured;
}

function resolveZalouserInboundSessionKey(params: {
  core: ZalouserCoreRuntime;
  config: OpenClawConfig;
  route: { agentId: string; accountId: string; sessionKey: string };
  storePath: string;
  isGroup: boolean;
  senderId: string;
}): string {
  if (params.isGroup) {
    return params.route.sessionKey;
  }

  const directSessionKey = normalizeLowercaseStringOrEmpty(
    params.core.channel.routing.buildAgentSessionKey({
      accountId: params.route.accountId,
      agentId: params.route.agentId,
      channel: "zalouser",
      dmScope: resolveZalouserDmSessionScope(params.config),
      identityLinks: params.config.session?.identityLinks,
      peer: { id: params.senderId, kind: "direct" },
    }),
  );
  const legacySessionKey = normalizeLowercaseStringOrEmpty(
    params.core.channel.routing.buildAgentSessionKey({
      accountId: params.route.accountId,
      agentId: params.route.agentId,
      channel: "zalouser",
      peer: { id: params.senderId, kind: "group" },
    }),
  );
  const hasDirectSession =
    params.core.channel.session.readSessionUpdatedAt({
      sessionKey: directSessionKey,
      storePath: params.storePath,
    }) !== undefined;
  const hasLegacySession =
    params.core.channel.session.readSessionUpdatedAt({
      sessionKey: legacySessionKey,
      storePath: params.storePath,
    }) !== undefined;

  // Keep existing DM history on upgrade, but use canonical direct keys for new sessions.
  return hasLegacySession && !hasDirectSession ? legacySessionKey : directSessionKey;
}

function logVerbose(core: ZalouserCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[zalouser] ${message}`);
  }
}

function isSenderAllowed(senderId: string | undefined, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeOptionalLowercaseString(senderId);
  if (!normalizedSenderId) {
    return false;
  }
  return allowFrom.some((entry) => {
    const normalized = normalizeLowercaseStringOrEmpty(entry).replace(/^(zalouser|zlu):/i, "");
    return normalized === normalizedSenderId;
  });
}

function resolveGroupRequireMention(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  allowNameMatching?: boolean;
}): boolean {
  const entry = findZalouserGroupEntry(
    params.groups ?? {},
    buildZalouserGroupCandidates({
      allowNameMatching: params.allowNameMatching,
      groupId: params.groupId,
      groupName: params.groupName,
      includeGroupIdAlias: true,
      includeWildcard: true,
    }),
  );
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  return true;
}

async function sendZalouserDeliveryAcks(params: {
  profile: string;
  isGroup: boolean;
  message: NonNullable<ZaloInboundMessage["eventMessage"]>;
}): Promise<void> {
  await sendDeliveredZalouser({
    isGroup: params.isGroup,
    isSeen: true,
    message: params.message,
    profile: params.profile,
  });
  await sendSeenZalouser({
    isGroup: params.isGroup,
    message: params.message,
    profile: params.profile,
  });
}

async function processMessage(
  message: ZaloInboundMessage,
  account: ResolvedZalouserAccount,
  config: OpenClawConfig,
  core: ZalouserCoreRuntime,
  runtime: RuntimeEnv,
  historyState: ZalouserGroupHistoryState,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: "zalouser",
    core,
  });

  const rawBody = message.content?.trim();
  if (!rawBody) {
    return;
  }
  const commandBody = message.commandContent?.trim() || rawBody;

  const {isGroup} = message;
  const chatId = message.threadId;
  const senderId = message.senderId?.trim();
  if (!senderId) {
    logVerbose(core, runtime, `zalouser: drop message ${chatId} (missing senderId)`);
    return;
  }
  const senderName = message.senderName ?? "";
  const configuredGroupName = message.groupName?.trim() || "";
  const groupContext =
    isGroup && !configuredGroupName
      ? await resolveZaloGroupContext(account.profile, chatId).catch((error) => {
          logVerbose(
            core,
            runtime,
            `zalouser: group context lookup failed for ${chatId}: ${String(error)}`,
          );
          return null;
        })
      : null;
  const groupName = configuredGroupName || groupContext?.name?.trim() || "";
  const groupMembers = groupContext?.members?.slice(0, 20).join(", ") || undefined;

  if (message.eventMessage) {
    try {
      await sendZalouserDeliveryAcks({
        isGroup,
        message: message.eventMessage,
        profile: account.profile,
      });
    } catch (error) {
      logVerbose(core, runtime, `zalouser: delivery/seen ack failed for ${chatId}: ${String(error)}`);
    }
  }

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    defaultGroupPolicy,
    groupPolicy: account.config.groupPolicy,
    providerConfigPresent: config.channels?.zalouser !== undefined,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: account.accountId,
    log: (entry) => logVerbose(core, runtime, entry),
    providerKey: "zalouser",
    providerMissingFallbackApplied,
  });

  const groups = account.config.groups ?? {};
  const routeAllowlistConfigured = Object.keys(groups).length > 0;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  if (isGroup) {
    const groupEntry = findZalouserGroupEntry(
      groups,
      buildZalouserGroupCandidates({
        allowNameMatching,
        groupId: chatId,
        groupName,
        includeGroupIdAlias: true,
        includeWildcard: true,
      }),
    );
    const routeAccess = evaluateGroupRouteAccessForPolicy({
      groupPolicy,
      routeAllowlistConfigured,
      routeEnabled: isZalouserGroupEntryAllowed(groupEntry),
      routeMatched: Boolean(groupEntry),
    });
    if (!routeAccess.allowed) {
      if (routeAccess.reason === "disabled") {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=disabled)`);
      } else if (routeAccess.reason === "empty_allowlist") {
        logVerbose(
          core,
          runtime,
          `zalouser: drop group ${chatId} (groupPolicy=allowlist, no allowlist)`,
        );
      } else if (routeAccess.reason === "route_not_allowlisted") {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (not allowlisted)`);
      } else if (routeAccess.reason === "route_disabled") {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (group disabled)`);
      }
      return;
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
  const senderGroupPolicy =
    routeAllowlistConfigured && configGroupAllowFrom.length === 0
      ? groupPolicy
      : resolveSenderScopedGroupPolicy({
          groupAllowFrom: configGroupAllowFrom,
          groupPolicy,
        });
  const shouldComputeCommandAuth = core.channel.commands.shouldComputeCommandAuthorized(
    commandBody,
    config,
  );
  const storeAllowFrom =
    !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeCommandAuth)
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const accessDecision = resolveDmGroupAccessWithLists({
    allowFrom: configAllowFrom,
    dmPolicy,
    groupAllowFrom: configGroupAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    groupPolicy: senderGroupPolicy,
    isGroup,
    isSenderAllowed: (allowFrom) => isSenderAllowed(senderId, allowFrom),
    storeAllowFrom,
  });
  if (isGroup && accessDecision.decision !== "allow") {
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
      logVerbose(core, runtime, "Blocked zalouser group message (no group allowlist)");
    } else if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
      logVerbose(
        core,
        runtime,
        `Blocked zalouser sender ${senderId} (not in groupAllowFrom/allowFrom)`,
      );
    }
    return;
  }

  if (!isGroup && accessDecision.decision !== "allow") {
    if (accessDecision.decision === "pairing") {
      await pairing.issueChallenge({
        meta: { name: senderName || undefined },
        onCreated: () => {
          logVerbose(core, runtime, `zalouser pairing request sender=${senderId}`);
        },
        onReplyError: (err) => {
          logVerbose(
            core,
            runtime,
            `zalouser pairing reply failed for ${senderId}: ${String(err)}`,
          );
        },
        sendPairingReply: async (text) => {
          await sendMessageZalouser(chatId, text, { profile: account.profile });
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        senderId,
        senderIdLine: `Your Zalo user id: ${senderId}`,
      });
      return;
    }
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
      logVerbose(core, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
    } else {
      logVerbose(
        core,
        runtime,
        `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`,
      );
    }
    return;
  }

  const { commandAuthorized } = await resolveSenderCommandAuthorization({
    cfg: config,
    configuredAllowFrom: configAllowFrom,
    configuredGroupAllowFrom: configGroupAllowFrom,
    dmPolicy,
    isGroup,
    isSenderAllowed,
    rawBody: commandBody,
    readAllowFromStore: async () => storeAllowFrom,
    resolveCommandAuthorizedFromAuthorizers: (params) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
    senderId,
    shouldComputeCommandAuthorized: (body, cfg) =>
      core.channel.commands.shouldComputeCommandAuthorized(body, cfg),
  });
  const hasControlCommand = core.channel.commands.isControlCommandMessage(commandBody, config);
  if (isGroup && hasControlCommand && commandAuthorized !== true) {
    logVerbose(
      core,
      runtime,
      `zalouser: drop control command from unauthorized sender ${senderId}`,
    );
    return;
  }

  const peer = isGroup
    ? { id: chatId, kind: "group" as const }
    : { id: senderId, kind: "direct" as const };

  const route = core.channel.routing.resolveAgentRoute({
    accountId: account.accountId,
    cfg: config,
    channel: "zalouser",
    peer: {
      // Keep DM peer kind as "direct" so session keys follow dmScope and UI labels stay DM-shaped.
      id: peer.id,
      kind: peer.kind,
    },
  });
  const historyKey = isGroup ? route.sessionKey : undefined;

  const requireMention = isGroup
    ? resolveGroupRequireMention({
        allowNameMatching,
        groupId: chatId,
        groupName,
        groups,
      })
    : false;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const explicitMention = {
    canResolveExplicit: message.canResolveExplicitMention === true,
    hasAnyMention: message.hasAnyMention === true,
    isExplicitlyMentioned: message.wasExplicitlyMentioned === true,
  };
  const wasMentioned = isGroup
    ? core.channel.mentions.matchesMentionWithExplicit({
        explicit: explicitMention,
        mentionRegexes,
        text: rawBody,
      })
    : true;
  const canDetectMention = mentionRegexes.length > 0 || explicitMention.canResolveExplicit;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      hasAnyMention: explicitMention.hasAnyMention,
      implicitMentionKinds: implicitMentionKindWhen("quoted_bot", message.implicitMention === true),
      wasMentioned,
    },
    policy: {
      allowTextCommands: core.channel.commands.shouldHandleTextCommands({
        cfg: config,
        surface: "zalouser",
      }),
      commandAuthorized: commandAuthorized === true,
      hasControlCommand,
      isGroup,
      requireMention,
    },
  });
  if (isGroup && requireMention && !canDetectMention && !mentionDecision.effectiveWasMentioned) {
    runtime.error?.(
      `[${account.accountId}] zalouser mention required but detection unavailable ` +
        `(missing mention regexes and bot self id); dropping group ${chatId}`,
    );
    return;
  }
  if (isGroup && mentionDecision.shouldSkip) {
    recordPendingHistoryEntryIfEnabled({
      entry:
        historyKey && rawBody
          ? {
              body: rawBody,
              messageId: resolveZalouserMessageSid({
                msgId: message.msgId,
                cliMsgId: message.cliMsgId,
                fallback: `${message.timestampMs}`,
              }),
              sender: senderName || senderId,
              timestamp: message.timestampMs,
            }
          : null,
      historyKey: historyKey ?? "",
      historyMap: historyState.groupHistories,
      limit: historyState.historyLimit,
    });
    logVerbose(core, runtime, `zalouser: skip group ${chatId} (mention required, not mentioned)`);
    return;
  }

  const fromLabel = isGroup ? groupName || `group:${chatId}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const inboundSessionKey = resolveZalouserInboundSessionKey({
    config,
    core,
    isGroup,
    route,
    senderId,
    storePath,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    sessionKey: inboundSessionKey,
    storePath,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    body: rawBody,
    channel: "Zalo Personal",
    envelope: envelopeOptions,
    from: fromLabel,
    previousTimestamp,
    timestamp: message.timestampMs,
  });
  const combinedBody =
    isGroup && historyKey
      ? buildPendingHistoryContextFromMap({
          currentMessage: body,
          formatEntry: (entry) =>
            core.channel.reply.formatAgentEnvelope({
              body: `${entry.sender}: ${entry.body}${
                entry.messageId ? ` [id:${entry.messageId}]` : ""
              }`,
              channel: "Zalo Personal",
              envelope: envelopeOptions,
              from: fromLabel,
              timestamp: entry.timestamp,
            }),
          historyKey,
          historyMap: historyState.groupHistories,
          limit: historyState.historyLimit,
        })
      : body;
  const inboundHistory =
    isGroup && historyKey && historyState.historyLimit > 0
      ? (historyState.groupHistories.get(historyKey) ?? []).map((entry) => ({
          body: entry.body,
          sender: entry.sender,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const normalizedTo = isGroup ? `zalouser:group:${chatId}` : `zalouser:${chatId}`;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: combinedBody,
    BodyForAgent: rawBody,
    BodyForCommands: commandBody,
    ChatType: isGroup ? "group" : "direct",
    CommandAuthorized: commandAuthorized,
    CommandBody: commandBody,
    ConversationLabel: fromLabel,
    From: isGroup ? `zalouser:group:${chatId}` : `zalouser:${senderId}`,
    GroupChannel: isGroup ? groupName || undefined : undefined,
    GroupMembers: isGroup ? groupMembers : undefined,
    GroupSubject: isGroup ? groupName || undefined : undefined,
    InboundHistory: inboundHistory,
    MessageSid: resolveZalouserMessageSid({
      cliMsgId: message.cliMsgId,
      fallback: `${message.timestampMs}`,
      msgId: message.msgId,
    }),
    MessageSidFull: formatZalouserMessageSidFull({
      cliMsgId: message.cliMsgId,
      msgId: message.msgId,
    }),
    OriginatingChannel: "zalouser",
    OriginatingTo: normalizedTo,
    Provider: "zalouser",
    RawBody: rawBody,
    SenderId: senderId,
    SenderName: senderName || undefined,
    SessionKey: inboundSessionKey,
    Surface: "zalouser",
    To: normalizedTo,
    WasMentioned: isGroup ? mentionDecision.effectiveWasMentioned : undefined,
  });

  await core.channel.session.recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`zalouser: failed updating session meta: ${String(err)}`);
    },
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    storePath,
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: account.accountId,
    agentId: route.agentId,
    cfg: config,
    channel: "zalouser",
    typing: {
      onStartError: (err) => {
        runtime.error?.(
          `[${account.accountId}] zalouser typing start failed for ${chatId}: ${String(err)}`,
        );
        logVerbose(core, runtime, `zalouser typing failed for ${chatId}: ${String(err)}`);
      },
      start: async () => {
        await sendTypingZalouser(chatId, {
          isGroup,
          profile: account.profile,
        });
      },
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    cfg: config,
    ctx: ctxPayload,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        await deliverZalouserReply({
          accountId: account.accountId,
          chatId,
          config,
          core,
          isGroup,
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          profile: account.profile,
          runtime,
          statusSink,
          tableMode: core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "zalouser",
            accountId: account.accountId,
          }),
        });
      },
      onError: (err, info) => {
        runtime.error(`[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({
      historyKey,
      historyMap: historyState.groupHistories,
      limit: historyState.historyLimit,
    });
  }
}

async function deliverZalouserReply(params: {
  payload: OutboundReplyPayload;
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: ZalouserCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId, statusSink } =
    params;
  const tableMode = params.tableMode ?? "code";
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "zalouser", accountId);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(config, "zalouser", accountId, {
    fallbackLimit: ZALOUSER_TEXT_LIMIT,
  });
  await deliverTextOrMediaReply({
    onMediaError: (error) => {
      runtime.error(
        `Zalouser media send failed: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
    },
    payload,
    sendMedia: async ({ mediaUrl, caption }) => {
      logVerbose(core, runtime, `Sending media to ${chatId}`);
      await sendMessageZalouser(chatId, caption ?? "", {
        isGroup,
        mediaUrl,
        profile,
        textChunkLimit,
        textChunkMode: chunkMode,
        textMode: "markdown",
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    sendText: async (chunk) => {
      try {
        await sendMessageZalouser(chatId, chunk, {
          isGroup,
          profile,
          textChunkLimit,
          textChunkMode: chunkMode,
          textMode: "markdown",
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (error) {
        runtime.error(`Zalouser message send failed: ${String(error)}`);
      }
    },
    text: reply.text,
  });
}

export async function monitorZalouserProvider(
  options: ZalouserMonitorOptions,
): Promise<ZalouserMonitorResult> {
  let { account, config } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getZalouserRuntime();
  const inboundQueue = new KeyedAsyncQueue();
  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      config.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();

  try {
    const {profile} = account;
    const allowFromEntries = (account.config.allowFrom ?? [])
      .map((entry) => normalizeZalouserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    const groupAllowFromEntries = (account.config.groupAllowFrom ?? [])
      .map((entry) => normalizeZalouserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (allowFromEntries.length > 0 || groupAllowFromEntries.length > 0) {
      const friends = await listZaloFriends(profile);
      const byName = buildNameIndex(friends, (friend) => friend.displayName);
      if (allowFromEntries.length > 0) {
        const { additions, mapping, unresolved } = resolveUserAllowlistEntries(
          allowFromEntries,
          byName,
        );
        const allowFrom = mergeAllowlist({ additions, existing: account.config.allowFrom });
        account = {
          ...account,
          config: {
            ...account.config,
            allowFrom,
          },
        };
        summarizeMapping("zalouser users", mapping, unresolved, runtime);
      }
      if (groupAllowFromEntries.length > 0) {
        const { additions, mapping, unresolved } = resolveUserAllowlistEntries(
          groupAllowFromEntries,
          byName,
        );
        const groupAllowFrom = mergeAllowlist({
          additions,
          existing: account.config.groupAllowFrom,
        });
        account = {
          ...account,
          config: {
            ...account.config,
            groupAllowFrom,
          },
        };
        summarizeMapping("zalouser group users", mapping, unresolved, runtime);
      }
    }

    const groupsConfig = account.config.groups ?? {};
    const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
    if (groupKeys.length > 0) {
      const groups = await listZaloGroups(profile);
      const byName = buildNameIndex(groups, (group) => group.name);
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const nextGroups = { ...groupsConfig };
      for (const entry of groupKeys) {
        const cleaned = normalizeZalouserEntry(entry);
        if (/^\d+$/.test(cleaned)) {
          if (!nextGroups[cleaned]) {
            nextGroups[cleaned] = groupsConfig[entry];
          }
          mapping.push(`${entry}→${cleaned}`);
          continue;
        }
        const matches = byName.get(normalizeLowercaseStringOrEmpty(cleaned)) ?? [];
        const match = matches[0];
        const id = match?.groupId ? String(match.groupId) : undefined;
        if (id) {
          if (!nextGroups[id]) {
            nextGroups[id] = groupsConfig[entry];
          }
          mapping.push(`${entry}→${id}`);
        } else {
          unresolved.push(entry);
        }
      }
      account = {
        ...account,
        config: {
          ...account.config,
          groups: nextGroups,
        },
      };
      summarizeMapping("zalouser groups", mapping, unresolved, runtime);
    }
  } catch (error) {
    runtime.log?.(`zalouser resolve failed; using config entries. ${String(error)}`);
  }

  let listenerStop: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    listenerStop?.();
    listenerStop = null;
  };

  let settled = false;
  const { promise: waitForExit, resolve: resolveRun, reject: rejectRun } = createDeferred<void>();

  const settleSuccess = () => {
    if (settled) {
      return;
    }
    settled = true;
    stop();
    resolveRun();
  };

  const settleFailure = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    stop();
    rejectRun(error instanceof Error ? error : new Error(String(error)));
  };

  const onAbort = () => {
    settleSuccess();
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });

  let listener: Awaited<ReturnType<typeof startZaloListener>>;
  try {
    listener = await startZaloListener({
      abortSignal,
      accountId: account.accountId,
      onError: (err) => {
        if (stopped || abortSignal.aborted) {
          return;
        }
        runtime.error(`[${account.accountId}] Zalo listener error: ${String(err)}`);
        settleFailure(err);
      },
      onMessage: (msg) => {
        if (stopped) {
          return;
        }
        logVerbose(core, runtime, `[${account.accountId}] inbound message`);
        statusSink?.({ lastInboundAt: Date.now() });
        const queueKey = resolveInboundQueueKey(msg);
        void inboundQueue
          .enqueue(queueKey, async () => {
            if (stopped || abortSignal.aborted) {
              return;
            }
            await processMessage(
              msg,
              account,
              config,
              core,
              runtime,
              { groupHistories, historyLimit },
              statusSink,
            );
          })
          .catch((error) => {
            runtime.error(`[${account.accountId}] Failed to process message: ${String(error)}`);
          });
      },
      profile: account.profile,
    });
  } catch (error) {
    abortSignal.removeEventListener("abort", onAbort);
    throw error;
  }

  listenerStop = listener.stop;
  if (stopped) {
    listenerStop();
    listenerStop = null;
  }

  if (abortSignal.aborted) {
    settleSuccess();
  }

  try {
    await waitForExit;
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }

  return { stop };
}

export const __testing = {
  processMessage: async (params: {
    message: ZaloInboundMessage;
    account: ResolvedZalouserAccount;
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    historyState?: {
      historyLimit?: number;
      groupHistories?: Map<string, HistoryEntry[]>;
    };
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  }) => {
    const historyLimit = Math.max(
      0,
      params.historyState?.historyLimit ??
        params.account.config.historyLimit ??
        params.config.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );
    const groupHistories = params.historyState?.groupHistories ?? new Map<string, HistoryEntry[]>();
    await processMessage(
      params.message,
      params.account,
      params.config,
      getZalouserRuntime(),
      params.runtime,
      { groupHistories, historyLimit },
      params.statusSink,
    );
  },
};
