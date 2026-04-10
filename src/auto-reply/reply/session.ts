import crypto from "node:crypto";
import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { disposeSessionMcpRuntime } from "../../agents/pi-bundle-mcp-tools.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import { resolveSessionTranscriptPath, resolveStorePath } from "../../config/sessions/paths.js";
import {
  type SessionFreshness,
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../../config/sessions/reset.js";
import { resolveAndPersistSessionFile } from "../../config/sessions/session-file.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions/store.js";
import {
  DEFAULT_RESET_TRIGGERS,
  type GroupKeyResolution,
  type SessionEntry,
  type SessionScope,
} from "../../config/sessions/types.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { deliverSessionMaintenanceWarning } from "../../infra/session-maintenance-warning.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookSessionEndReason } from "../../plugins/types.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { isInterSessionInputProvenance } from "../../sessions/input-provenance.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  maybeRetireLegacyMainDeliveryRoute,
  resolveLastChannelRaw,
  resolveLastToRaw,
} from "./session-delivery.js";
import { forkSessionFromParent, resolveParentForkMaxTokens } from "./session-fork.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";

const log = createSubsystemLogger("session-init");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function resolveExplicitSessionEndReason(
  matchedResetTriggerLower?: string,
): PluginHookSessionEndReason {
  return matchedResetTriggerLower === "/reset" ? "reset" : "new";
}

function resolveSessionDefaultAccountId(params: {
  cfg: OpenClawConfig;
  channelRaw?: string;
  accountIdRaw?: string;
  persistedLastAccountId?: string;
}): string | undefined {
  const explicit = normalizeOptionalString(params.accountIdRaw);
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeOptionalString(params.persistedLastAccountId);
  if (persisted) {
    return persisted;
  }
  const channel = normalizeOptionalLowercaseString(params.channelRaw);
  if (!channel) {
    return undefined;
  }
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefault = channels?.[channel]?.defaultAccount;
  return normalizeOptionalString(configuredDefault);
}

function resolveStaleSessionEndReason(params: {
  entry: SessionEntry | undefined;
  freshness?: SessionFreshness;
  now: number;
}): PluginHookSessionEndReason | undefined {
  if (!params.entry || !params.freshness) {
    return undefined;
  }
  const staleDaily =
    params.freshness.dailyResetAt != null && params.entry.updatedAt < params.freshness.dailyResetAt;
  const staleIdle =
    params.freshness.idleExpiresAt != null && params.now > params.freshness.idleExpiresAt;
  if (staleIdle) {
    return "idle";
  }
  if (staleDaily) {
    return "daily";
  }
  return undefined;
}

export interface SessionInitResult {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
}

function isResetAuthorizedForContext(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): boolean {
  const auth = resolveCommandAuthorization(params);
  if (!params.commandAuthorized && !auth.isAuthorizedSender) {
    return false;
  }
  const provider = params.ctx.Provider;
  const internalGatewayCaller = provider
    ? isInternalMessageChannel(provider)
    : isInternalMessageChannel(params.ctx.Surface);
  if (!internalGatewayCaller) {
    return true;
  }
  const scopes = params.ctx.GatewayClientScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return true;
  }
  return scopes.includes("operator.admin");
}

function resolveSessionConversationBindingContext(
  cfg: OpenClawConfig,
  ctx: MsgContext,
): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg,
    ctx,
  });
  if (!bindingContext) {
    return null;
  }
  return {
    accountId: bindingContext.accountId,
    channel: bindingContext.channel,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  };
}

function resolveBoundConversationSessionKey(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  bindingContext?: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null;
}): string | undefined {
  const bindingContext =
    params.bindingContext ?? resolveSessionConversationBindingContext(params.cfg, params.ctx);
  if (!bindingContext) {
    return undefined;
  }
  const binding = getSessionBindingService().resolveByConversation({
    accountId: bindingContext.accountId,
    channel: bindingContext.channel,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  if (!binding?.targetSessionKey) {
    return undefined;
  }
  getSessionBindingService().touch(binding.bindingId);
  return binding.targetSessionKey;
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  const conversationBindingContext = resolveSessionConversationBindingContext(cfg, ctx);
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const commandTargetSessionKey =
    ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined;
  // Native slash/menu commands can arrive on a transport-specific "slash session"
  // While explicitly targeting an existing chat session. Honor that explicit target
  // Before any binding lookup so command-side mutations land on the intended session.
  const targetSessionKey =
    commandTargetSessionKey ??
    resolveBoundConversationSessionKey({
      bindingContext: conversationBindingContext,
      cfg,
      ctx,
    });
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    config: cfg,
    sessionKey: sessionCtxForState.SessionKey,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const parentForkMaxTokens = resolveParentForkMaxTokens(cfg);
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const ingressTimingEnabled = process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";

  // CRITICAL: Skip cache to ensure fresh data when resolving session identity.
  // Stale cache (especially with multiple gateway processes or on Windows where
  // Mtime granularity may miss rapid writes) can cause incorrect sessionId
  // Generation, leading to orphaned transcript files. See #17971.
  const sessionStoreLoadStartMs = ingressTimingEnabled ? Date.now() : 0;
  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath, {
    skipCache: true,
  });
  if (ingressTimingEnabled) {
    log.info(
      `session-init store-load agent=${agentId} session=${sessionCtxForState.SessionKey ?? "(no-session)"} ` +
        `elapsedMs=${Date.now() - sessionStoreLoadStartMs} path=${storePath}`,
    );
  }
  let sessionKey: string | undefined;
  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;
  let resetTriggered = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;
  let persistedReasoning: string | undefined;
  let persistedTtsAuto: TtsAutoMode | undefined;
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;
  let persistedAuthProfileOverride: string | undefined;
  let persistedAuthProfileOverrideSource: SessionEntry["authProfileOverrideSource"];
  let persistedAuthProfileOverrideCompactionCount: number | undefined;
  let persistedLabel: string | undefined;
  let persistedSpawnedBy: SessionEntry["spawnedBy"];
  let persistedSpawnedWorkspaceDir: SessionEntry["spawnedWorkspaceDir"];
  let persistedParentSessionKey: SessionEntry["parentSessionKey"];
  let persistedForkedFromParent: SessionEntry["forkedFromParent"];
  let persistedSpawnDepth: SessionEntry["spawnDepth"];
  let persistedSubagentRole: SessionEntry["subagentRole"];
  let persistedSubagentControlScope: SessionEntry["subagentControlScope"];
  let persistedDisplayName: SessionEntry["displayName"];

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // To Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  // IMPORTANT: do NOT lowercase the entire command body.
  // Users often pass case-sensitive arguments (e.g. filesystem paths on Linux).
  // Command parsing downstream lowercases only the command token for matching.
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();

  // Use CommandBody/RawBody for reset trigger matching (clean message without structural context).
  const rawBody = commandSource;
  const trimmedBody = rawBody.trim();
  const resetAuthorized = isResetAuthorizedForContext({
    cfg,
    commandAuthorized,
    ctx,
  });
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // Web inbox before we get here. They prevented reset triggers like "/new"
  // From matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;
  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = normalizeLowercaseStringOrEmpty(trimmedBody);
  const strippedForResetLower = normalizeLowercaseStringOrEmpty(strippedForReset);
  let matchedResetTriggerLower: string | undefined;

  for (const trigger of resetTriggers) {
    if (!trigger) {
      continue;
    }
    if (!resetAuthorized) {
      break;
    }
    const triggerLower = normalizeLowercaseStringOrEmpty(trigger);
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      matchedResetTriggerLower = triggerLower;
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      trimmedBodyLower.startsWith(triggerPrefixLower) ||
      strippedForResetLower.startsWith(triggerPrefixLower)
    ) {
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      matchedResetTriggerLower = triggerLower;
      break;
    }
  }

  // Canonicalize so the written key matches what all read paths produce.
  // ResolveSessionKey uses DEFAULT_AGENT_ID="main"; the configured default
  // Agent may differ, causing key mismatch and orphaned sessions (#29683).
  sessionKey = canonicalizeMainSessionAlias({
    agentId,
    cfg,
    sessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey),
  });
  const retiredLegacyMainDelivery = maybeRetireLegacyMainDeliveryRoute({
    agentId,
    ctx,
    isGroup,
    mainKey,
    sessionCfg,
    sessionKey,
    sessionStore,
  });
  if (retiredLegacyMainDelivery) {
    sessionStore[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
  }
  const entry = sessionStore[sessionKey];
  const now = Date.now();
  const isThread = resolveThreadFlag({
    messageThreadId: ctx.MessageThreadId,
    parentSessionKey: ctx.ParentSessionKey,
    sessionKey,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
  });
  const resetType = resolveSessionResetType({ isGroup, isThread, sessionKey });
  const channelReset = resolveChannelResetConfig({
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
    sessionCfg,
  });
  const resetPolicy = resolveSessionResetPolicy({
    resetOverride: channelReset,
    resetType,
    sessionCfg,
  });
  // Heartbeat, cron-event, and exec-event runs should NEVER trigger session resets.
  // These are automated system events, not user interactions that should affect
  // Session continuity. Forcing freshEntry=true prevents accidental data loss.
  // See #58409 for details on silent session reset bug.
  const isSystemEvent =
    ctx.Provider === "heartbeat" || ctx.Provider === "cron-event" || ctx.Provider === "exec-event";
  const entryFreshness = entry
    ? (isSystemEvent
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({ now, policy: resetPolicy, updatedAt: entry.updatedAt }))
    : undefined;
  const freshEntry = entryFreshness?.fresh ?? false;
  // Capture the current session entry before any reset so its transcript can be
  // Archived afterward.  We need to do this for both explicit resets (/new, /reset)
  // And for scheduled/daily resets where the session has become stale (!freshEntry).
  // Without this, daily-reset transcripts are left as orphaned files on disk (#35481).
  const previousSessionEntry = (resetTriggered || !freshEntry) && entry ? { ...entry } : undefined;
  const previousSessionEndReason = resetTriggered
    ? resolveExplicitSessionEndReason(matchedResetTriggerLower)
    : resolveStaleSessionEndReason({
        entry,
        freshness: entryFreshness,
        now,
      });
  clearBootstrapSnapshotOnSessionRollover({
    previousSessionId: previousSessionEntry?.sessionId,
    sessionKey,
  });

  if (!isNewSession && freshEntry) {
    ({ sessionId } = entry);
    systemSent = entry.systemSent ?? false;
    abortedLastRun = entry.abortedLastRun ?? false;
    persistedThinking = entry.thinkingLevel;
    persistedVerbose = entry.verboseLevel;
    persistedReasoning = entry.reasoningLevel;
    persistedTtsAuto = entry.ttsAuto;
    persistedModelOverride = entry.modelOverride;
    persistedProviderOverride = entry.providerOverride;
    persistedAuthProfileOverride = entry.authProfileOverride;
    persistedAuthProfileOverrideSource = entry.authProfileOverrideSource;
    persistedAuthProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    persistedLabel = entry.label;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
    // When a reset trigger (/new, /reset) starts a new session, carry over
    // User-set behavior overrides (verbose, thinking, reasoning, ttsAuto)
    // So the user doesn't have to re-enable them every time.
    if (resetTriggered && entry) {
      persistedThinking = entry.thinkingLevel;
      persistedVerbose = entry.verboseLevel;
      persistedReasoning = entry.reasoningLevel;
      persistedTtsAuto = entry.ttsAuto;
      persistedModelOverride = entry.modelOverride;
      persistedProviderOverride = entry.providerOverride;
      persistedAuthProfileOverride = entry.authProfileOverride;
      persistedAuthProfileOverrideSource = entry.authProfileOverrideSource;
      persistedAuthProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
      // Explicit /new and /reset should rotate the underlying CLI conversation too.
      // Keep the model/auth choice, but force the next turn to mint a fresh CLI binding.
      persistedLabel = entry.label;
      persistedSpawnedBy = entry.spawnedBy;
      persistedSpawnedWorkspaceDir = entry.spawnedWorkspaceDir;
      persistedParentSessionKey = entry.parentSessionKey;
      persistedForkedFromParent = entry.forkedFromParent;
      persistedSpawnDepth = entry.spawnDepth;
      persistedSubagentRole = entry.subagentRole;
      persistedSubagentControlScope = entry.subagentControlScope;
      persistedDisplayName = entry.displayName;
    }
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const originatingChannelRaw = ctx.OriginatingChannel as string | undefined;
  const isInterSession = isInterSessionInputProvenance(ctx.InputProvenance);
  const lastChannelRaw = resolveLastChannelRaw({
    isInterSession,
    originatingChannelRaw,
    persistedLastChannel: baseEntry?.lastChannel,
    sessionKey,
  });
  const lastToRaw = resolveLastToRaw({
    isInterSession,
    originatingChannelRaw,
    originatingToRaw: ctx.OriginatingTo,
    persistedLastChannel: baseEntry?.lastChannel,
    persistedLastTo: baseEntry?.lastTo,
    sessionKey,
    toRaw: ctx.To,
  });
  const lastAccountIdRaw = resolveSessionDefaultAccountId({
    accountIdRaw: ctx.AccountId,
    cfg,
    channelRaw: lastChannelRaw,
    persistedLastAccountId: baseEntry?.lastAccountId,
  });
  // Only fall back to persisted threadId for thread sessions.  Non-thread
  // Sessions (e.g. DM without topics) must not inherit a stale threadId from a
  // Previous interaction that happened inside a topic/thread.
  const lastThreadIdRaw = ctx.MessageThreadId || (isThread ? baseEntry?.lastThreadId : undefined);
  const deliveryFields = normalizeSessionDeliveryFields({
    deliveryContext: {
      accountId: lastAccountIdRaw,
      channel: lastChannelRaw,
      threadId: lastThreadIdRaw,
      to: lastToRaw,
    },
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
  const lastThreadId = deliveryFields.lastThreadId ?? lastThreadIdRaw;
  sessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    systemSent,
    abortedLastRun,
    // Persist previously stored thinking/verbose levels when present.
    thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
    verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    reasoningLevel: persistedReasoning ?? baseEntry?.reasoningLevel,
    ttsAuto: persistedTtsAuto ?? baseEntry?.ttsAuto,
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
    authProfileOverride: persistedAuthProfileOverride ?? baseEntry?.authProfileOverride,
    authProfileOverrideSource:
      persistedAuthProfileOverrideSource ?? baseEntry?.authProfileOverrideSource,
    authProfileOverrideCompactionCount:
      persistedAuthProfileOverrideCompactionCount ?? baseEntry?.authProfileOverrideCompactionCount,
    cliSessionIds: baseEntry?.cliSessionIds,
    cliSessionBindings: baseEntry?.cliSessionBindings,
    claudeCliSessionId: baseEntry?.claudeCliSessionId,
    label: persistedLabel ?? baseEntry?.label,
    spawnedBy: persistedSpawnedBy ?? baseEntry?.spawnedBy,
    spawnedWorkspaceDir: persistedSpawnedWorkspaceDir ?? baseEntry?.spawnedWorkspaceDir,
    parentSessionKey: persistedParentSessionKey ?? baseEntry?.parentSessionKey,
    forkedFromParent: persistedForkedFromParent ?? baseEntry?.forkedFromParent,
    spawnDepth: persistedSpawnDepth ?? baseEntry?.spawnDepth,
    subagentRole: persistedSubagentRole ?? baseEntry?.subagentRole,
    subagentControlScope: persistedSubagentControlScope ?? baseEntry?.subagentControlScope,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: persistedDisplayName ?? baseEntry?.displayName,
    chatType: baseEntry?.chatType,
    channel: baseEntry?.channel,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    deliveryContext: deliveryFields.deliveryContext,
    // Track originating channel for subagent announce routing.
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    existing: sessionEntry,
    groupResolution,
    sessionKey,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = normalizeOptionalString(ctx.ParentSessionKey);
  const alreadyForked = sessionEntry.forkedFromParent === true;
  if (
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey] &&
    !alreadyForked
  ) {
    const parentTokens = sessionStore[parentSessionKey].totalTokens ?? 0;
    if (parentForkMaxTokens > 0 && parentTokens > parentForkMaxTokens) {
      // Parent context is too large — forking would create a thread session
      // That immediately overflows the model's context window. Start fresh
      // Instead and mark as forked to prevent re-attempts. See #26905.
      log.warn(
        `skipping parent fork (parent too large): parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens} maxTokens=${parentForkMaxTokens}`,
      );
      sessionEntry.forkedFromParent = true;
    } else {
      log.warn(
        `forking from parent session: parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens}`,
      );
      const forked = await forkSessionFromParent({
        agentId,
        parentEntry: sessionStore[parentSessionKey],
        sessionsDir: path.dirname(storePath),
      });
      if (forked) {
        ({ sessionId } = forked);
        sessionEntry.sessionId = forked.sessionId;
        sessionEntry.sessionFile = forked.sessionFile;
        sessionEntry.forkedFromParent = true;
        log.warn(`forked session created: file=${forked.sessionFile}`);
      }
    }
  }
  const fallbackSessionFile = !sessionEntry.sessionFile
    ? resolveSessionTranscriptPath(sessionEntry.sessionId, agentId, ctx.MessageThreadId)
    : undefined;
  const resolvedSessionFile = await resolveAndPersistSessionFile({
    activeSessionKey: sessionKey,
    agentId,
    fallbackSessionFile,
    sessionEntry,
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionStore,
    sessionsDir: path.dirname(storePath),
    storePath,
  });
  ({ sessionEntry } = resolvedSessionFile);
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
    // Clear stale context hash so the first flush in the new session is not
    // Incorrectly skipped due to a hash match with the old transcript (#30115).
    sessionEntry.memoryFlushContextHash = undefined;
    // Clear stale token metrics from previous session so /status doesn't
    // Display the old session's context usage after /new or /reset.
    sessionEntry.totalTokens = undefined;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.estimatedCostUsd = undefined;
    sessionEntry.contextTokens = undefined;
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(
    storePath,
    (store) => {
      // Preserve per-session overrides while resetting compaction state on /new.
      store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
      if (retiredLegacyMainDelivery) {
        store[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
      }
    },
    {
      activeSessionKey: sessionKey,
      onWarn: (warning) =>
        deliverSessionMaintenanceWarning({
          cfg,
          entry: sessionEntry,
          sessionKey,
          warning,
        }),
    },
  );

  // Archive old transcript so it doesn't accumulate on disk (#14869).
  let previousSessionTranscript: {
    sessionFile?: string;
    transcriptArchived?: boolean;
  } = {};
  if (previousSessionEntry?.sessionId) {
    const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
      await loadSessionArchiveRuntime();
    const archivedTranscripts = archiveSessionTranscriptsDetailed({
      agentId,
      reason: "reset",
      sessionFile: previousSessionEntry.sessionFile,
      sessionId: previousSessionEntry.sessionId,
      storePath,
    });
    previousSessionTranscript = resolveStableSessionEndTranscript({
      agentId,
      archivedTranscripts,
      sessionFile: previousSessionEntry.sessionFile,
      sessionId: previousSessionEntry.sessionId,
      storePath,
    });
    await disposeSessionMcpRuntime(previousSessionEntry.sessionId).catch((error) => {
      log.warn(
        `failed to dispose bundle MCP runtime for session ${previousSessionEntry.sessionId}`,
        {
          error: String(error),
        },
      );
    });
  }

  const sessionCtx: TemplateContext = {
    ...sessionCtxForState,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: normalizeInboundTextNewlines(
      bodyStripped ??
        sessionCtxForState.BodyForAgent ??
        sessionCtxForState.Body ??
        sessionCtxForState.CommandBody ??
        sessionCtxForState.RawBody ??
        sessionCtxForState.BodyForCommands ??
        "",
    ),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  // Run session plugin hooks (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isNewSession) {
    const effectiveSessionId = sessionId ?? "";

    // If replacing an existing session, fire session_end for the old one
    if (previousSessionEntry?.sessionId && previousSessionEntry.sessionId !== effectiveSessionId) {
      if (hookRunner.hasHooks("session_end")) {
        const payload = buildSessionEndHookPayload({
          cfg,
          nextSessionId: effectiveSessionId,
          reason: previousSessionEndReason,
          sessionFile: previousSessionTranscript.sessionFile,
          sessionId: previousSessionEntry.sessionId,
          sessionKey,
          transcriptArchived: previousSessionTranscript.transcriptArchived,
        });
        void hookRunner.runSessionEnd(payload.event, payload.context).catch(() => {});
      }
    }

    // Fire session_start for the new session
    if (hookRunner.hasHooks("session_start")) {
      const payload = buildSessionStartHookPayload({
        cfg,
        resumedFrom: previousSessionEntry?.sessionId,
        sessionId: effectiveSessionId,
        sessionKey,
      });
      void hookRunner.runSessionStart(payload.event, payload.context).catch(() => {});
    }
  }

  return {
    abortedLastRun,
    bodyStripped,
    groupResolution,
    isGroup,
    isNewSession,
    previousSessionEntry,
    resetTriggered,
    sessionCtx,
    sessionEntry,
    sessionId: sessionId ?? crypto.randomUUID(),
    sessionKey,
    sessionScope,
    sessionStore,
    storePath,
    systemSent,
    triggerBodyNormalized,
  };
}
