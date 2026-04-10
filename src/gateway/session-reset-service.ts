import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearBootstrapSnapshot } from "../agents/bootstrap-cache.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import { loadConfig } from "../config/config.js";
import {
  type SessionEntry,
  snapshotSessionOrigin,
  updateSessionStore,
} from "../config/sessions.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { logVerbose } from "../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { closeTrackedBrowserTabsForSessions } from "../plugin-sdk/browser-maintenance.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import {
  type ArchivedSessionTranscript,
  archiveSessionTranscriptsDetailed,
  resolveStableSessionEndTranscript,
} from "./session-transcript-files.fs.js";
import {
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "./session-utils.js";

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

function stripRuntimeModelState(entry?: SessionEntry): SessionEntry | undefined {
  if (!entry) {
    return entry;
  }
  return {
    ...entry,
    contextTokens: undefined,
    model: undefined,
    modelProvider: undefined,
    systemPromptReport: undefined,
  };
}

type ResetPreservedSelectionState = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

function resolveResetPreservedSelection(params: {
  entry?: SessionEntry;
}): Partial<ResetPreservedSelectionState> {
  const { entry } = params;
  if (!entry) {
    return {};
  }

  const preserved: Partial<ResetPreservedSelectionState> = {};
  // `modelOverrideSource` is new. Older persisted sessions can still carry
  // User-selected overrides without the source field, so treat an absent
  // Source as legacy user state during reset and backfill it forward.
  const preserveLegacyUserModelOverride =
    entry.modelOverrideSource === "user" ||
    (entry.modelOverrideSource === undefined && Boolean(entry.modelOverride));
  if (preserveLegacyUserModelOverride && entry.modelOverride) {
    preserved.providerOverride = entry.providerOverride;
    preserved.modelOverride = entry.modelOverride;
    preserved.modelOverrideSource = "user";
  }

  if (entry.authProfileOverrideSource === "user" && entry.authProfileOverride) {
    preserved.authProfileOverride = entry.authProfileOverride;
    preserved.authProfileOverrideSource = entry.authProfileOverrideSource;
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      preserved.authProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    }
  }

  return preserved;
}

export function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  return archiveSessionTranscriptsForSessionDetailed(params).map((entry) => entry.archivedPath);
}

export function archiveSessionTranscriptsForSessionDetailed(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): ArchivedSessionTranscript[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscriptsDetailed({
    agentId: params.agentId,
    reason: params.reason,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
}

export function emitGatewaySessionEndPluginHook(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
  archivedTranscripts?: ArchivedSessionTranscript[];
  nextSessionId?: string;
  nextSessionKey?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_end")) {
    return;
  }
  const transcript = resolveStableSessionEndTranscript({
    agentId: params.agentId,
    archivedTranscripts: params.archivedTranscripts,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
  const payload = buildSessionEndHookPayload({
    cfg: params.cfg,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
    reason: params.reason,
    sessionFile: transcript.sessionFile,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    transcriptArchived: transcript.transcriptArchived,
  });
  void hookRunner.runSessionEnd(payload.event, payload.context).catch((error) => {
    logVerbose(`session_end hook failed: ${String(error)}`);
  });
}

export function emitGatewaySessionStartPluginHook(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  sessionId?: string;
  resumedFrom?: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_start")) {
    return;
  }
  const payload = buildSessionStartHookPayload({
    cfg: params.cfg,
    resumedFrom: params.resumedFrom,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  void hookRunner.runSessionStart(payload.event, payload.context).catch((error) => {
    logVerbose(`session_start hook failed: ${String(error)}`);
  });
}

export async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  await getSessionBindingService().unbind({
    reason: params.reason,
    targetSessionKey: params.targetSessionKey,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
      reason: params.reason,
      sendFarewell: true,
      targetKind,
      targetSessionKey: params.targetSessionKey,
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}) {
  const closeTrackedBrowserTabs = async () => {
    const closeKeys = new Set<string>([
      params.key,
      params.target.canonicalKey,
      ...params.target.storeKeys,
      params.sessionId ?? "",
    ]);
    return await closeTrackedBrowserTabsForSessions({
      onWarn: (message) => logVerbose(message),
      sessionKeys: [...closeKeys],
    });
  };

  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionQueues([...queueKeys]);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    clearBootstrapSnapshot(params.target.canonicalKey);
    await closeTrackedBrowserTabs();
    return undefined;
  }
  abortEmbeddedPiRun(params.sessionId);
  const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
  clearBootstrapSnapshot(params.target.canonicalKey);
  if (ended) {
    await closeTrackedBrowserTabs();
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ error, status: "error" as const }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
  if (!params.entry?.acp) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        reason: params.reason,
        sessionKey: params.sessionKey,
      });
    },
  });
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        allowBackendUnavailable: true,
        cfg: params.cfg,
        discardPersistentState: true,
        reason: params.reason,
        requireAcpSession: false,
        sessionKey: params.sessionKey,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  await ensureFreshAcpResetState({
    cfg: params.cfg,
    entry: params.entry,
    reason: params.reason,
    sessionKey: params.sessionKey,
  });
  return undefined;
}

function buildPendingAcpMeta(base: SessionAcpMeta, now: number): SessionAcpMeta {
  const currentIdentity = base.identity;
  const nextIdentity = currentIdentity
    ? {
        state: "pending" as const,
        ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
        source: currentIdentity.source,
        lastUpdatedAt: now,
      }
    : undefined;
  return {
    backend: base.backend,
    agent: base.agent,
    runtimeSessionName: base.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: base.mode,
    ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    state: "idle",
    lastActivityAt: now,
  };
}

async function ensureFreshAcpResetState(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  reason: "session-reset" | "session-delete";
  entry?: SessionEntry;
}): Promise<void> {
  if (params.reason !== "session-reset" || !params.entry?.acp) {
    return;
  }
  const latestMeta = readAcpSessionEntry({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  })?.acp;
  if (
    !latestMeta?.identity ||
    latestMeta.identity.state !== "resolved" ||
    (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)
  ) {
    return;
  }

  const backendId = (latestMeta.backend || params.cfg.acp?.backend || "").trim() || undefined;
  try {
    await getAcpRuntimeBackend(backendId)?.runtime.prepareFreshSession?.({
      sessionKey: params.sessionKey,
    });
  } catch (error) {
    logVerbose(
      `sessions.${params.reason}: ACP prepareFreshSession failed for ${params.sessionKey}: ${String(error)}`,
    );
  }

  const now = Date.now();
  await upsertAcpSessionMeta({
    cfg: params.cfg,
    mutate: (current, entry) => {
      const base = current ?? entry?.acp;
      if (!base) {
        return null;
      }
      return buildPendingAcpMeta(base, now);
    },
    sessionKey: params.sessionKey,
  });
}

export async function cleanupSessionBeforeMutation(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
  legacyKey?: string;
  canonicalKey?: string;
  reason: "session-reset" | "session-delete";
}) {
  const cleanupError = await ensureSessionRuntimeCleanup({
    cfg: params.cfg,
    key: params.key,
    sessionId: params.entry?.sessionId,
    target: params.target,
  });
  if (cleanupError) {
    return cleanupError;
  }
  return await closeAcpRuntimeForSession({
    cfg: params.cfg,
    entry: params.entry,
    reason: params.reason,
    sessionKey: params.legacyKey ?? params.canonicalKey ?? params.target.canonicalKey ?? params.key,
  });
}

function emitGatewayBeforeResetPluginHook(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  storePath: string;
  entry?: SessionEntry;
  reason: "new" | "reset";
}): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  const sessionKey = params.target.canonicalKey ?? params.key;
  const sessionId = params.entry?.sessionId;
  const sessionFile = params.entry?.sessionFile;
  const agentId = normalizeAgentId(params.target.agentId ?? resolveDefaultAgentId(params.cfg));
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  let messages: unknown[] = [];
  try {
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      messages = readSessionMessages(sessionId, params.storePath, sessionFile);
    }
  } catch (error) {
    logVerbose(
      `before_reset: failed to read session messages for ${sessionId ?? "(none)"}; firing hook with empty messages (${String(error)})`,
    );
  }

  void hookRunner
    .runBeforeReset(
      {
        messages,
        reason: params.reason,
        sessionFile,
      },
      {
        agentId,
        sessionId,
        sessionKey,
        workspaceDir,
      },
    )
    .catch((error) => {
      logVerbose(`before_reset hook failed: ${String(error)}`);
    });
}

export async function performGatewaySessionReset(params: {
  key: string;
  reason: "new" | "reset";
  commandSource: string;
}): Promise<
  | { ok: true; key: string; entry: SessionEntry }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const { cfg, target, storePath } = (() => {
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: params.key });
    return { cfg, storePath: target.storePath, target };
  })();
  const { entry, legacyKey, canonicalKey } = loadSessionEntry(params.key);
  const hadExistingEntry = Boolean(entry);
  const hookEvent = createInternalHookEvent(
    "command",
    params.reason,
    target.canonicalKey ?? params.key,
    {
      cfg,
      commandSource: params.commandSource,
      previousSessionEntry: entry,
      sessionEntry: entry,
    },
  );
  await triggerInternalHook(hookEvent);
  const mutationCleanupError = await cleanupSessionBeforeMutation({
    canonicalKey,
    cfg,
    entry,
    key: params.key,
    legacyKey,
    reason: "session-reset",
    target,
  });
  if (mutationCleanupError) {
    return { error: mutationCleanupError, ok: false };
  }

  let oldSessionId: string | undefined;
  let oldSessionFile: string | undefined;
  let resetSourceEntry: SessionEntry | undefined;
  const next = await updateSessionStore(storePath, (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: params.key,
      store,
    });
    const currentEntry = store[primaryKey];
    resetSourceEntry = currentEntry ? { ...currentEntry } : undefined;
    const parsed = parseAgentSessionKey(primaryKey);
    const sessionAgentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resetPreservedSelection = resolveResetPreservedSelection({
      entry: currentEntry,
    });
    const resetEntry = {
      ...stripRuntimeModelState(currentEntry),
      authProfileOverride: undefined,
      authProfileOverrideCompactionCount: undefined,
      authProfileOverrideSource: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      providerOverride: undefined,
      ...resetPreservedSelection,
    };
    const resolvedModel = resolveSessionModelRef(cfg, resetEntry, sessionAgentId);
    oldSessionId = currentEntry?.sessionId;
    oldSessionFile = currentEntry?.sessionFile;
    const now = Date.now();
    const nextSessionId = randomUUID();
    const sessionFile = resolveSessionFilePath(
      nextSessionId,
      currentEntry?.sessionFile ? { sessionFile: currentEntry.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        agentId: sessionAgentId,
        storePath,
      }),
    );
    const nextEntry: SessionEntry = {
      sessionId: nextSessionId,
      sessionFile,
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: currentEntry?.thinkingLevel,
      fastMode: currentEntry?.fastMode,
      verboseLevel: currentEntry?.verboseLevel,
      reasoningLevel: currentEntry?.reasoningLevel,
      elevatedLevel: currentEntry?.elevatedLevel,
      ttsAuto: currentEntry?.ttsAuto,
      execHost: currentEntry?.execHost,
      execSecurity: currentEntry?.execSecurity,
      execAsk: currentEntry?.execAsk,
      execNode: currentEntry?.execNode,
      responseUsage: currentEntry?.responseUsage,
      // Resets should keep the user's explicit selection, but clear any
      // Temporary fallback model that was pinned during the previous run.
      ...resetPreservedSelection,
      groupActivation: currentEntry?.groupActivation,
      groupActivationNeedsSystemIntro: currentEntry?.groupActivationNeedsSystemIntro,
      chatType: currentEntry?.chatType,
      model: resolvedModel.model,
      modelProvider: resolvedModel.provider,
      contextTokens: resetEntry?.contextTokens,
      compactionCount: currentEntry?.compactionCount,
      compactionCheckpoints: currentEntry?.compactionCheckpoints,
      sendPolicy: currentEntry?.sendPolicy,
      queueMode: currentEntry?.queueMode,
      queueDebounceMs: currentEntry?.queueDebounceMs,
      queueCap: currentEntry?.queueCap,
      queueDrop: currentEntry?.queueDrop,
      spawnedBy: currentEntry?.spawnedBy,
      spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
      parentSessionKey: currentEntry?.parentSessionKey,
      forkedFromParent: currentEntry?.forkedFromParent,
      spawnDepth: currentEntry?.spawnDepth,
      subagentRole: currentEntry?.subagentRole,
      subagentControlScope: currentEntry?.subagentControlScope,
      label: currentEntry?.label,
      displayName: currentEntry?.displayName,
      channel: currentEntry?.channel,
      groupId: currentEntry?.groupId,
      subject: currentEntry?.subject,
      groupChannel: currentEntry?.groupChannel,
      space: currentEntry?.space,
      origin: snapshotSessionOrigin(currentEntry),
      deliveryContext: currentEntry?.deliveryContext,
      cliSessionBindings: currentEntry?.cliSessionBindings,
      cliSessionIds: currentEntry?.cliSessionIds,
      claudeCliSessionId: currentEntry?.claudeCliSessionId,
      lastChannel: currentEntry?.lastChannel,
      lastTo: currentEntry?.lastTo,
      lastAccountId: currentEntry?.lastAccountId,
      lastThreadId: currentEntry?.lastThreadId,
      skillsSnapshot: currentEntry?.skillsSnapshot,
      acp: currentEntry?.acp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    };
    store[primaryKey] = nextEntry;
    return nextEntry;
  });
  emitGatewayBeforeResetPluginHook({
    cfg,
    entry: resetSourceEntry,
    key: params.key,
    reason: params.reason,
    storePath,
    target,
  });

  const archivedTranscripts = archiveSessionTranscriptsForSessionDetailed({
    agentId: target.agentId,
    reason: "reset",
    sessionFile: oldSessionFile,
    sessionId: oldSessionId,
    storePath,
  });
  fs.mkdirSync(path.dirname(next.sessionFile as string), { recursive: true });
  if (!fs.existsSync(next.sessionFile as string)) {
    const header = {
      cwd: process.cwd(),
      id: next.sessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: CURRENT_SESSION_VERSION,
    };
    fs.writeFileSync(next.sessionFile as string, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  emitGatewaySessionEndPluginHook({
    agentId: target.agentId,
    archivedTranscripts,
    cfg,
    nextSessionId: next.sessionId,
    reason: params.reason,
    sessionFile: oldSessionFile,
    sessionId: oldSessionId,
    sessionKey: target.canonicalKey ?? params.key,
    storePath,
  });
  emitGatewaySessionStartPluginHook({
    cfg,
    resumedFrom: oldSessionId,
    sessionId: next.sessionId,
    sessionKey: target.canonicalKey ?? params.key,
  });
  if (hadExistingEntry) {
    await emitSessionUnboundLifecycleEvent({
      reason: "session-reset",
      targetSessionKey: target.canonicalKey ?? params.key,
    });
  }
  return { entry: next, key: target.canonicalKey, ok: true };
}
