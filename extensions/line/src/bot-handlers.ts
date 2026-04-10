import type { webhook } from "@line/bot-sdk";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { hasControlCommand, resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
import {
  readChannelAllowFromStore,
  resolvePairingIdLabel,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { evaluateMatchedGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  type NormalizedAllowFrom,
  firstDefined,
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
} from "./bot-access.js";
import {
  type LineInboundContext,
  buildLineMessageContext,
  buildLinePostbackContext,
  getLineSourceInfo,
} from "./bot-message-context.js";
import { downloadLineMedia } from "./download.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";

type FollowEvent = webhook.FollowEvent;
type JoinEvent = webhook.JoinEvent;
type LeaveEvent = webhook.LeaveEvent;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type UnfollowEvent = webhook.UnfollowEvent;
type WebhookEvent = webhook.Event;

interface MediaRef {
  path: string;
  contentType?: string;
}

const LINE_DOWNLOADABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function isDownloadableLineMessageType(
  messageType: MessageEvent["message"]["type"],
): messageType is "image" | "video" | "audio" | "file" {
  return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}

export interface LineHandlerContext {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  mediaMaxBytes: number;
  processMessage: (ctx: LineInboundContext) => Promise<void>;
  replayCache?: LineWebhookReplayCache;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
}

const LINE_WEBHOOK_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const LINE_WEBHOOK_REPLAY_MAX_ENTRIES = 4096;
const LINE_WEBHOOK_REPLAY_PRUNE_INTERVAL_MS = 1000;
export interface LineWebhookReplayCache {
  seenEvents: Map<string, number>;
  inFlightEvents: Map<string, Promise<void>>;
  lastPruneAtMs: number;
}

export function createLineWebhookReplayCache(): LineWebhookReplayCache {
  return {
    inFlightEvents: new Map<string, Promise<void>>(),
    lastPruneAtMs: 0,
    seenEvents: new Map<string, number>(),
  };
}

function pruneLineWebhookReplayCache(cache: LineWebhookReplayCache, nowMs: number): void {
  const minSeenAt = nowMs - LINE_WEBHOOK_REPLAY_WINDOW_MS;
  for (const [key, seenAt] of cache.seenEvents) {
    if (seenAt < minSeenAt) {
      cache.seenEvents.delete(key);
    }
  }

  if (cache.seenEvents.size > LINE_WEBHOOK_REPLAY_MAX_ENTRIES) {
    const deleteCount = cache.seenEvents.size - LINE_WEBHOOK_REPLAY_MAX_ENTRIES;
    let deleted = 0;
    for (const key of cache.seenEvents.keys()) {
      if (deleted >= deleteCount) {
        break;
      }
      cache.seenEvents.delete(key);
      deleted += 1;
    }
  }
}

function buildLineWebhookReplayKey(
  event: WebhookEvent,
  accountId: string,
): { key: string; eventId: string } | null {
  if (event.type === "message") {
    const messageId = event.message?.id?.trim();
    if (messageId) {
      return {
        eventId: `message:${messageId}`,
        key: `${accountId}|message:${messageId}`,
      };
    }
  }
  const eventId = (event as { webhookEventId?: string }).webhookEventId?.trim();
  if (!eventId) {
    return null;
  }

  const {source} = (
    event as {
      source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
    }
  );
  const sourceId =
    source?.type === "group"
      ? `group:${source.groupId ?? ""}`
      : (source?.type === "room"
        ? `room:${source.roomId ?? ""}`
        : `user:${source?.userId ?? ""}`);
  return { eventId: `event:${eventId}`, key: `${accountId}|${event.type}|${sourceId}|${eventId}` };
}

interface LineReplayCandidate {
  key: string;
  eventId: string;
  seenAtMs: number;
  cache: LineWebhookReplayCache;
}

interface LineInFlightReplayResult {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function getLineReplayCandidate(
  event: WebhookEvent,
  context: LineHandlerContext,
): LineReplayCandidate | null {
  const replay = buildLineWebhookReplayKey(event, context.account.accountId);
  const cache = context.replayCache;
  if (!replay || !cache) {
    return null;
  }

  const nowMs = Date.now();
  if (
    nowMs - cache.lastPruneAtMs >= LINE_WEBHOOK_REPLAY_PRUNE_INTERVAL_MS ||
    cache.seenEvents.size >= LINE_WEBHOOK_REPLAY_MAX_ENTRIES
  ) {
    pruneLineWebhookReplayCache(cache, nowMs);
    cache.lastPruneAtMs = nowMs;
  }
  return { cache, eventId: replay.eventId, key: replay.key, seenAtMs: nowMs };
}

function shouldSkipLineReplayEvent(
  candidate: LineReplayCandidate,
): { skip: true; inFlightResult?: Promise<void> } | { skip: false } {
  const inFlightResult = candidate.cache.inFlightEvents.get(candidate.key);
  if (inFlightResult) {
    logVerbose(`line: skipped in-flight replayed webhook event ${candidate.eventId}`);
    return { inFlightResult, skip: true };
  }
  if (candidate.cache.seenEvents.has(candidate.key)) {
    logVerbose(`line: skipped replayed webhook event ${candidate.eventId}`);
    return { skip: true };
  }
  return { skip: false };
}

function markLineReplayEventInFlight(candidate: LineReplayCandidate): LineInFlightReplayResult {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  candidate.cache.inFlightEvents.set(candidate.key, promise);
  return { promise, reject, resolve };
}

function clearLineReplayEventInFlight(candidate: LineReplayCandidate): void {
  candidate.cache.inFlightEvents.delete(candidate.key);
}

function rememberLineReplayEvent(candidate: LineReplayCandidate): void {
  candidate.cache.seenEvents.set(candidate.key, candidate.seenAtMs);
}

function resolveLineGroupConfig(params: {
  config: ResolvedLineAccount["config"];
  groupId?: string;
  roomId?: string;
}): LineGroupConfig | undefined {
  return resolveLineGroupConfigEntry(params.config.groups, {
    groupId: params.groupId,
    roomId: params.roomId,
  });
}

async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  await createChannelPairingChallengeIssuer({
    channel: "line",
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertChannelPairingRequest({
        accountId: context.account.accountId,
        channel: "line",
        id,
        meta,
      }),
  })({
    onCreated: () => {
      logVerbose(`line pairing request sender=${senderId}`);
    },
    sendPairingReply: async (text) => {
      if (replyToken) {
        try {
          await replyMessageLine(replyToken, [{ text, type: "text" }], {
            accountId: context.account.accountId,
            channelAccessToken: context.account.channelAccessToken,
          });
          return;
        } catch (error) {
          logVerbose(`line pairing reply failed for ${senderId}: ${String(error)}`);
        }
      }
      try {
        await pushMessageLine(`line:${senderId}`, text, {
          accountId: context.account.accountId,
          channelAccessToken: context.account.channelAccessToken,
        });
      } catch (error) {
        logVerbose(`line pairing reply failed for ${senderId}: ${String(error)}`);
      }
    },
    senderId,
    senderIdLine: `Your ${idLabel}: ${senderId}`,
  });
}

async function shouldProcessLineEvent(
  event: MessageEvent | PostbackEvent,
  context: LineHandlerContext,
): Promise<{ allowed: boolean; commandAuthorized: boolean }> {
  const denied = { allowed: false, commandAuthorized: false };
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const senderId = userId ?? "";
  const dmPolicy = account.config.dmPolicy ?? "pairing";

  const storeAllowFrom = await readChannelAllowFromStore(
    "line",
    undefined,
    account.accountId,
  ).catch(() => []);
  const effectiveDmAllow = normalizeDmAllowFromWithStore({
    allowFrom: account.config.allowFrom,
    dmPolicy,
    storeAllowFrom,
  });
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const groupAllowOverride = groupConfig?.allowFrom;
  const fallbackGroupAllowFrom = account.config.allowFrom?.length
    ? account.config.allowFrom
    : undefined;
  const groupAllowFrom = firstDefined(
    groupAllowOverride,
    account.config.groupAllowFrom,
    fallbackGroupAllowFrom,
  );
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowFrom);
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      defaultGroupPolicy,
      groupPolicy: account.config.groupPolicy,
      providerConfigPresent: cfg.channels?.line !== undefined,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: account.accountId,
    log: (message) => logVerbose(message),
    providerKey: "line",
    providerMissingFallbackApplied,
  });

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
      return denied;
    }
    if (typeof groupAllowOverride !== "undefined") {
      if (!senderId) {
        logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
        return denied;
      }
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
        return denied;
      }
    }
    const senderGroupAccess = evaluateMatchedGroupAccessForPolicy({
      allowlistConfigured: effectiveGroupAllow.entries.length > 0,
      allowlistMatched:
        Boolean(senderId) &&
        isSenderAllowed({
          allow: effectiveGroupAllow,
          senderId,
        }),
      groupPolicy,
      hasMatchInput: Boolean(senderId),
      requireMatchInput: true,
    });
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
      logVerbose("Blocked line group message (groupPolicy: disabled)");
      return denied;
    }
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "missing_match_input") {
      logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
      return denied;
    }
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
      logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
      return denied;
    }
    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "not_allowlisted") {
      logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
      return denied;
    }
    return {
      allowed: true,
      commandAuthorized: resolveLineCommandAuthorized({
        allow: effectiveGroupAllow,
        cfg,
        event,
        senderId,
      }),
    };
  }

  if (dmPolicy === "disabled") {
    logVerbose("Blocked line sender (dmPolicy: disabled)");
    return denied;
  }

  const dmAllowed = dmPolicy === "open" || isSenderAllowed({ allow: effectiveDmAllow, senderId });
  if (!dmAllowed) {
    if (dmPolicy === "pairing") {
      if (!senderId) {
        logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
        return denied;
      }
      await sendLinePairingReply({
        context,
        replyToken: "replyToken" in event ? event.replyToken : undefined,
        senderId,
      });
    } else {
      logVerbose(`Blocked line sender ${senderId || "unknown"} (dmPolicy: ${dmPolicy})`);
    }
    return denied;
  }

  return {
    allowed: true,
    commandAuthorized: resolveLineCommandAuthorized({
      allow: effectiveDmAllow,
      cfg,
      event,
      senderId,
    }),
  };
}

function getLineMentionees(
  message: MessageEvent["message"],
): { type?: string; isSelf?: boolean }[] {
  if (message.type !== "text") {
    return [];
  }
  const mentionees = (
    message as Record<string, unknown> & {
      mention?: { mentionees?: { type?: string; isSelf?: boolean }[] };
    }
  ).mention?.mentionees;
  return Array.isArray(mentionees) ? mentionees : [];
}

function isLineBotMentioned(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).some((m) => m.isSelf === true || m.type === "all");
}

function hasAnyLineMention(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).length > 0;
}

function resolveEventRawText(event: MessageEvent | PostbackEvent): string {
  if (event.type === "message") {
    const msg = event.message;
    if (msg.type === "text") {
      return msg.text;
    }
    return "";
  }
  if (event.type === "postback") {
    return event.postback?.data?.trim() ?? "";
  }
  return "";
}

function resolveLineCommandAuthorized(params: {
  cfg: OpenClawConfig;
  event: MessageEvent | PostbackEvent;
  senderId?: string;
  allow: NormalizedAllowFrom;
}): boolean {
  const senderAllowedForCommands = isSenderAllowed({
    allow: params.allow,
    senderId: params.senderId,
  });
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const rawText = resolveEventRawText(params.event);
  const commandGate = resolveControlCommandGate({
    allowTextCommands: true,
    authorizers: [{ allowed: senderAllowedForCommands, configured: params.allow.hasEntries }],
    hasControlCommand: hasControlCommand(rawText, params.cfg),
    useAccessGroups,
  });
  return commandGate.commandAuthorized;
}

async function handleMessageEvent(event: MessageEvent, context: LineHandlerContext): Promise<void> {
  const { cfg, account, runtime, mediaMaxBytes, processMessage } = context;
  const {message} = event;

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision.allowed) {
    return;
  }

  const { isGroup, groupId, roomId } = getLineSourceInfo(event.source);
  if (isGroup) {
    const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
    const requireMention = groupConfig?.requireMention !== false;
    const rawText = message.type === "text" ? message.text : "";
    const sourceInfo = getLineSourceInfo(event.source);
    const peerId = groupId ?? roomId ?? sourceInfo.userId ?? "unknown";
    const { agentId } = resolveAgentRoute({
      accountId: account.accountId,
      cfg,
      channel: "line",
      peer: { id: peerId, kind: "group" },
    });
    const mentionRegexes = buildMentionRegexes(cfg, agentId);
    const wasMentionedByNative = isLineBotMentioned(message);
    const wasMentionedByPattern =
      message.type === "text" ? matchesMentionPatterns(rawText, mentionRegexes) : false;
    const wasMentioned = wasMentionedByNative || wasMentionedByPattern;
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: message.type === "text",
        hasAnyMention: hasAnyLineMention(message),
        implicitMentionKinds: [],
        wasMentioned,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized: decision.commandAuthorized,
        hasControlCommand: hasControlCommand(rawText, cfg),
        isGroup: true,
        requireMention,
      },
    });
    if (mentionDecision.shouldSkip) {
      logVerbose(`line: skipping group message (requireMention, not mentioned)`);
      const historyKey = groupId ?? roomId;
      const senderId = sourceInfo.userId ?? "unknown";
      if (historyKey && context.groupHistories) {
        recordPendingHistoryEntryIfEnabled({
          entry: {
            body: rawText || `<${message.type}>`,
            sender: `user:${senderId}`,
            timestamp: event.timestamp,
          },
          historyKey,
          historyMap: context.groupHistories,
          limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
        });
      }
      return;
    }
  }

  const allMedia: MediaRef[] = [];

  if (isDownloadableLineMessageType(message.type)) {
    try {
      const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes);
      allMedia.push({
        contentType: media.contentType,
        path: media.path,
      });
    } catch (error) {
      const errMsg = String(error);
      if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
        logVerbose(`line: media exceeds size limit for message ${message.id}`);
      } else {
        runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
      }
    }
  }

  const messageContext = await buildLineMessageContext({
    account,
    allMedia,
    cfg,
    commandAuthorized: decision.commandAuthorized,
    event,
    groupHistories: context.groupHistories,
    historyLimit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  });

  if (!messageContext) {
    logVerbose("line: skipping empty message");
    return;
  }

  await processMessage(messageContext);

  if (isGroup && context.groupHistories) {
    const historyKey = groupId ?? roomId;
    if (historyKey && context.groupHistories.has(historyKey)) {
      clearHistoryEntriesIfEnabled({
        historyKey,
        historyMap: context.groupHistories,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
      });
    }
  }
}

async function handleFollowEvent(event: FollowEvent, _context: LineHandlerContext): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} followed`);
}

async function handleUnfollowEvent(
  event: UnfollowEvent,
  _context: LineHandlerContext,
): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}

async function handleJoinEvent(event: JoinEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handleLeaveEvent(event: LeaveEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handlePostbackEvent(
  event: PostbackEvent,
  context: LineHandlerContext,
): Promise<void> {
  const {data} = event.postback;
  logVerbose(`line: received postback: ${data}`);

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision.allowed) {
    return;
  }

  const postbackContext = await buildLinePostbackContext({
    account: context.account,
    cfg: context.cfg,
    commandAuthorized: decision.commandAuthorized,
    event,
  });
  if (!postbackContext) {
    return;
  }

  await context.processMessage(postbackContext);
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  let firstError: unknown;
  for (const event of events) {
    const replayCandidate = getLineReplayCandidate(event, context);
    const replaySkip = replayCandidate ? shouldSkipLineReplayEvent(replayCandidate) : null;
    if (replaySkip?.skip) {
      if (replaySkip.inFlightResult) {
        try {
          await replaySkip.inFlightResult;
        } catch (error) {
          context.runtime.error?.(danger(`line: replayed in-flight event failed: ${String(error)}`));
          firstError ??= error;
        }
      }
      continue;
    }
    const inFlightReservation = replayCandidate
      ? markLineReplayEventInFlight(replayCandidate)
      : null;
    try {
      switch (event.type) {
        case "message": {
          await handleMessageEvent(event, context);
          break;
        }
        case "follow": {
          await handleFollowEvent(event, context);
          break;
        }
        case "unfollow": {
          await handleUnfollowEvent(event, context);
          break;
        }
        case "join": {
          await handleJoinEvent(event, context);
          break;
        }
        case "leave": {
          await handleLeaveEvent(event, context);
          break;
        }
        case "postback": {
          await handlePostbackEvent(event, context);
          break;
        }
        default: {
          logVerbose(`line: unhandled event type: ${(event as WebhookEvent).type}`);
        }
      }
      if (replayCandidate) {
        rememberLineReplayEvent(replayCandidate);
        inFlightReservation?.resolve();
        clearLineReplayEventInFlight(replayCandidate);
      }
    } catch (error) {
      if (replayCandidate) {
        inFlightReservation?.reject(error);
        clearLineReplayEventInFlight(replayCandidate);
      }
      context.runtime.error?.(danger(`line: event handler failed: ${String(error)}`));
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
}
