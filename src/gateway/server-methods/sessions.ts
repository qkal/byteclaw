import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded-runner/runs.js";
import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { normalizeReasoningLevel, normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import {
  type SessionEntry,
  loadSessionStore,
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
  validateSessionsCompactParams,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionGetParams,
  validateSessionsCompactionListParams,
  validateSessionsCompactionRestoreParams,
  validateSessionsCreateParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSendParams,
} from "../protocol/index.js";
import {
  getSessionCompactionCheckpoint,
  listSessionCompactionCheckpoints,
} from "../session-compaction-checkpoints.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadGatewaySessionRow,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionMessages,
  readSessionPreviewItemsFromTranscript,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { chatHandlers } from "./chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = normalizeOptionalString(raw) ?? "";
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, storePath: target.storePath, target };
}

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

function shouldAttachPendingMessageSeq(params: { payload: unknown; cached?: boolean }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

function emitSessionsChanged(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: { sessionKey?: string; reason: string; compacted?: boolean },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            abortedLastRun: sessionRow.abortedLastRun,
            channel: sessionRow.channel,
            chatType: sessionRow.chatType,
            childSessions: sessionRow.childSessions,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            contextTokens: sessionRow.contextTokens,
            deliveryContext: sessionRow.deliveryContext,
            displayName: sessionRow.displayName,
            elevatedLevel: sessionRow.elevatedLevel,
            endedAt: sessionRow.endedAt,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            fastMode: sessionRow.fastMode,
            forkedFromParent: sessionRow.forkedFromParent,
            groupChannel: sessionRow.groupChannel,
            inputTokens: sessionRow.inputTokens,
            kind: sessionRow.kind,
            label: sessionRow.label,
            lastAccountId: sessionRow.lastAccountId,
            lastChannel: sessionRow.lastChannel,
            lastThreadId: sessionRow.lastThreadId,
            lastTo: sessionRow.lastTo,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
            model: sessionRow.model,
            modelProvider: sessionRow.modelProvider,
            origin: sessionRow.origin,
            outputTokens: sessionRow.outputTokens,
            parentSessionKey: sessionRow.parentSessionKey,
            reasoningLevel: sessionRow.reasoningLevel,
            responseUsage: sessionRow.responseUsage,
            runtimeMs: sessionRow.runtimeMs,
            sendPolicy: sessionRow.sendPolicy,
            sessionId: sessionRow.sessionId,
            space: sessionRow.space,
            spawnDepth: sessionRow.spawnDepth,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            startedAt: sessionRow.startedAt,
            status: sessionRow.status,
            subagentControlScope: sessionRow.subagentControlScope,
            subagentRole: sessionRow.subagentRole,
            subject: sessionRow.subject,
            systemSent: sessionRow.systemSent,
            thinkingLevel: sessionRow.thinkingLevel,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            updatedAt: sessionRow.updatedAt ?? undefined,
            verboseLevel: sessionRow.verboseLevel,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
}

function cloneCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  nextSessionId: string;
  nextSessionFile: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
}): SessionEntry {
  return {
    ...params.currentEntry,
    abortedLastRun: false,
    cacheRead: undefined,
    cacheWrite: undefined,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
    endedAt: undefined,
    estimatedCostUsd: undefined,
    inputTokens: undefined,
    label: params.label ?? params.currentEntry.label,
    outputTokens: undefined,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    runtimeMs: undefined,
    sessionFile: params.nextSessionFile,
    sessionId: params.nextSessionId,
    startedAt: undefined,
    status: undefined,
    systemSent: false,
    totalTokens:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? params.totalTokens
        : undefined,
    totalTokensFresh:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? true
        : undefined,
    updatedAt: Date.now(),
  };
}

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): { ok: true; transcriptPath: string } | { ok: false; error: string } {
  try {
    const transcriptPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    );
    if (!fs.existsSync(transcriptPath)) {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        cwd: process.cwd(),
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        type: "session",
        version: CURRENT_SESSION_VERSION,
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    return { ok: true, transcriptPath };
  } catch (error) {
    return {
      error: formatErrorMessage(error),
      ok: false,
    };
  }
}

function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  runId?: string;
}): string {
  const activeRunKey =
    typeof params.runId === "string"
      ? params.context.chatAbortControllers.get(params.runId)?.sessionKey
      : undefined;
  if (activeRunKey) {
    return activeRunKey;
  }
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey) {
      return params.canonicalKey;
    }
    if (active.sessionKey === params.requestedKey) {
      return params.requestedKey;
    }
  }
  return params.requestedKey;
}

function hasTrackedActiveSessionRun(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
}): boolean {
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey || active.sessionKey === params.requestedKey) {
      return true;
    }
  }
  return false;
}

async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const hasTrackedRun = hasTrackedActiveSessionRun({
    canonicalKey: params.canonicalKey,
    context: params.context,
    requestedKey: params.requestedKey,
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedPiRunActive(params.sessionId)
      : false;

  if (!hasTrackedRun && !hasEmbeddedRun) {
    return { interrupted: false };
  }

  if (hasTrackedRun) {
    let abortOk = true;
    let abortError: ReturnType<typeof errorShape> | undefined;
    const abortSessionKey = resolveAbortSessionKey({
      canonicalKey: params.canonicalKey,
      context: params.context,
      requestedKey: params.requestedKey,
    });

    await chatHandlers["chat.abort"]({
      client: params.client,
      context: params.context,
      isWebchatConnect: params.isWebchatConnect,
      params: {
        sessionKey: abortSessionKey,
      },
      req: params.req,
      respond: (ok, _payload, error) => {
        abortOk = ok;
        abortError = error;
      },
    });

    if (!abortOk) {
      return {
        error:
          abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session"),
        interrupted: true,
      };
    }
  }

  if (hasEmbeddedRun && params.sessionId) {
    abortEmbeddedPiRun(params.sessionId);
  }

  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
    if (!ended) {
      return {
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.requestedKey} is still active; try again in a moment.`,
        ),
        interrupted: true,
      };
    }
  }

  return { interrupted: true };
}

async function handleSessionSend(params: {
  method: "sessions.send" | "sessions.steer";
  req: GatewayRequestHandlerOptions["req"];
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  interruptIfActive: boolean;
}) {
  if (
    !assertValidParams(params.params, validateSessionsSendParams, params.method, params.respond)
  ) {
    return;
  }
  const p = params.params;
  const key = requireSessionKey((p as { key?: unknown }).key, params.respond);
  if (!key) {
    return;
  }
  const { entry, canonicalKey, storePath } = loadSessionEntry(key);
  if (!entry?.sessionId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
    );
    return;
  }

  let interruptedActiveRun = false;
  if (params.interruptIfActive) {
    const interruptResult = await interruptSessionRunIfActive({
      canonicalKey,
      client: params.client,
      context: params.context,
      isWebchatConnect: params.isWebchatConnect,
      req: params.req,
      requestedKey: key,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      params.respond(false, undefined, interruptResult.error);
      return;
    }
    interruptedActiveRun = interruptResult.interrupted;
  }

  const messageSeq = readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length + 1;
  let sendAcked = false;
  let sendPayload: unknown;
  let sendCached = false;
  let startedRunId: string | undefined;
  const rawIdempotencyKey = (p as { idempotencyKey?: string }).idempotencyKey;
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : randomUUID();
  await chatHandlers["chat.send"]({
    client: params.client,
    context: params.context,
    isWebchatConnect: params.isWebchatConnect,
    params: {
      attachments: (p as { attachments?: unknown[] }).attachments,
      idempotencyKey,
      message: (p as { message: string }).message,
      sessionKey: canonicalKey,
      thinking: (p as { thinking?: string }).thinking,
      timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
    },
    req: params.req,
    respond: (ok, payload, error, meta) => {
      sendAcked = ok;
      sendPayload = payload;
      sendCached = meta?.cached === true;
      startedRunId =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId
          : undefined;
      if (ok && shouldAttachPendingMessageSeq({ cached: meta?.cached === true, payload })) {
        params.respond(
          true,
          {
            ...(payload && typeof payload === "object" ? payload : {}),
            messageSeq,
            ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
          },
          undefined,
          meta,
        );
        return;
      }
      params.respond(
        ok,
        ok && payload && typeof payload === "object"
          ? {
              ...payload,
              ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
            }
          : payload,
        error,
        meta,
      );
    },
  });
  if (sendAcked) {
    if (shouldAttachPendingMessageSeq({ cached: sendCached, payload: sendPayload })) {
      await reactivateCompletedSubagentSession({
        runId: startedRunId,
        sessionKey: canonicalKey,
      });
    }
    emitSessionsChanged(params.context, {
      reason: interruptedActiveRun ? "steer" : "send",
      sessionKey: canonicalKey,
    });
  }
}
export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    const abortSessionKey = resolveAbortSessionKey({
      canonicalKey,
      context,
      requestedKey: key,
      runId: readStringValue(p.runId),
    });
    let abortedRunId: string | null = null;
    await chatHandlers["chat.abort"]({
      client,
      context,
      isWebchatConnect,
      params: {
        runId: readStringValue(p.runId),
        sessionKey: abortSessionKey,
      },
      req,
      respond: (ok, payload, error, meta) => {
        if (!ok) {
          respond(ok, payload, error, meta);
          return;
        }
        const runIds =
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { runIds?: unknown[] }).runIds)
            ? (payload as { runIds: unknown[] }).runIds.filter((value): value is string =>
                Boolean(normalizeOptionalString(value)),
              )
            : [];
        abortedRunId = runIds[0] ?? null;
        respond(
          true,
          {
            ok: true,
            abortedRunId,
            status: abortedRunId ? "aborted" : "no-active-run",
          },
          undefined,
          meta,
        );
      },
    });
    if (abortedRunId) {
      emitSessionsChanged(context, {
        reason: "abort",
        sessionKey: canonicalKey,
      });
    }
  },
  "sessions.compact": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : undefined;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const { entry } = compactTarget;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          compacted: false,
          key: target.canonicalKey,
          ok: true,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          compacted: false,
          key: target.canonicalKey,
          ok: true,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    if (maxLines === undefined) {
      const interruptResult = await interruptSessionRunIfActive({
        canonicalKey: target.canonicalKey,
        client,
        context,
        isWebchatConnect,
        req,
        requestedKey: key,
        sessionId,
      });
      if (interruptResult.error) {
        respond(false, undefined, interruptResult.error);
        return;
      }

      const resolvedModel = resolveSessionModelRef(cfg, entry, target.agentId);
      const workspaceDir =
        normalizeOptionalString(entry?.spawnedWorkspaceDir) ||
        resolveAgentWorkspaceDir(cfg, target.agentId);
      const result = await compactEmbeddedPiSession({
        allowGatewaySubagentBinding: true,
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        config: cfg,
        model: resolvedModel.model,
        provider: resolvedModel.provider,
        reasoningLevel: normalizeReasoningLevel(entry?.reasoningLevel),
        sessionFile: filePath,
        sessionId,
        sessionKey: target.canonicalKey,
        thinkLevel: normalizeThinkLevel(entry?.thinkingLevel),
        trigger: "manual",
        workspaceDir,
      });

      if (result.ok && result.compacted) {
        await updateSessionStore(storePath, (store) => {
          const entryKey = compactTarget.primaryKey;
          const entryToUpdate = store[entryKey];
          if (!entryToUpdate) {
            return;
          }
          entryToUpdate.updatedAt = Date.now();
          entryToUpdate.compactionCount = Math.max(0, entryToUpdate.compactionCount ?? 0) + 1;
          delete entryToUpdate.inputTokens;
          delete entryToUpdate.outputTokens;
          if (
            typeof result.result?.tokensAfter === "number" &&
            Number.isFinite(result.result.tokensAfter)
          ) {
            entryToUpdate.totalTokens = result.result.tokensAfter;
            entryToUpdate.totalTokensFresh = true;
          } else {
            delete entryToUpdate.totalTokens;
            delete entryToUpdate.totalTokensFresh;
          }
        });
      }

      respond(
        true,
        {
          compacted: result.compacted,
          key: target.canonicalKey,
          ok: result.ok,
          reason: result.reason,
          result: result.result,
        },
        undefined,
      );
      if (result.ok) {
        emitSessionsChanged(context, {
          compacted: result.compacted,
          reason: "compact",
          sessionKey: target.canonicalKey,
        });
      }
      return;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => Boolean(normalizeOptionalString(l)));
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          compacted: false,
          kept: lines.length,
          key: target.canonicalKey,
          ok: true,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        archived,
        compacted: true,
        kept: keptLines.length,
        key: target.canonicalKey,
        ok: true,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      compacted: true,
      reason: "compact",
      sessionKey: target.canonicalKey,
    });
  },
  "sessions.compaction.branch": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionBranchParams,
        "sessions.compaction.branch",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const loaded = loadSessionEntry(key);
    const { cfg, entry, canonicalKey } = loaded;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: canonicalKey });
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ checkpointId, entry });
    if (!checkpoint?.preCompaction.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    if (!fs.existsSync(checkpoint.preCompaction.sessionFile)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "checkpoint snapshot transcript is missing"),
      );
      return;
    }

    const snapshotSession = SessionManager.open(
      checkpoint.preCompaction.sessionFile,
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const branchedSession = SessionManager.forkFrom(
      checkpoint.preCompaction.sessionFile,
      snapshotSession.getCwd(),
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const branchedSessionFile = branchedSession.getSessionFile();
    if (!branchedSessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch transcript"),
      );
      return;
    }
    const nextKey = buildDashboardSessionKey(target.agentId);
    const label = entry.label?.trim() ? `${entry.label.trim()} (checkpoint)` : "Checkpoint branch";
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      label,
      nextSessionFile: branchedSessionFile,
      nextSessionId: branchedSession.getSessionId(),
      parentSessionKey: canonicalKey,
      totalTokens: checkpoint.tokensBefore,
    });

    await updateSessionStore(target.storePath, (store) => {
      store[nextKey] = nextEntry;
    });

    respond(
      true,
      {
        checkpoint,
        entry: nextEntry,
        key: nextKey,
        ok: true,
        sessionId: nextEntry.sessionId,
        sourceKey: canonicalKey,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      reason: "checkpoint-branch",
      sessionKey: canonicalKey,
    });
    emitSessionsChanged(context, {
      reason: "checkpoint-branch",
      sessionKey: nextKey,
    });
  },
  "sessions.compaction.get": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionGetParams,
        "sessions.compaction.get",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId = normalizeOptionalString(p.checkpointId) ?? "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const { entry, canonicalKey } = loadSessionEntry(key);
    const checkpoint = getSessionCompactionCheckpoint({ checkpointId, entry });
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    respond(
      true,
      {
        checkpoint,
        key: canonicalKey,
        ok: true,
      },
      undefined,
    );
  },
  "sessions.compaction.list": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionListParams,
        "sessions.compaction.list",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { entry, canonicalKey } = loadSessionEntry(key);
    respond(
      true,
      {
        checkpoints: listSessionCompactionCheckpoints(entry),
        key: canonicalKey,
        ok: true,
      },
      undefined,
    );
  },
  "sessions.compaction.restore": async ({
    req,
    params,
    respond,
    context,
    client,
    isWebchatConnect,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionRestoreParams,
        "sessions.compaction.restore",
        respond,
      )
    ) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const checkpointId =
      typeof p.checkpointId === "string" && p.checkpointId.trim() ? p.checkpointId.trim() : "";
    if (!checkpointId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "checkpointId required"));
      return;
    }
    const loaded = loadSessionEntry(key);
    const { entry, canonicalKey, storePath } = loaded;
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const checkpoint = getSessionCompactionCheckpoint({ checkpointId, entry });
    if (!checkpoint?.preCompaction.sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `checkpoint not found: ${checkpointId}`),
      );
      return;
    }
    if (!fs.existsSync(checkpoint.preCompaction.sessionFile)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "checkpoint snapshot transcript is missing"),
      );
      return;
    }

    const interruptResult = await interruptSessionRunIfActive({
      canonicalKey,
      client,
      context,
      isWebchatConnect,
      req,
      requestedKey: key,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      respond(false, undefined, interruptResult.error);
      return;
    }

    const snapshotSession = SessionManager.open(
      checkpoint.preCompaction.sessionFile,
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const restoredSession = SessionManager.forkFrom(
      checkpoint.preCompaction.sessionFile,
      snapshotSession.getCwd(),
      path.dirname(checkpoint.preCompaction.sessionFile),
    );
    const restoredSessionFile = restoredSession.getSessionFile();
    if (!restoredSessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to restore checkpoint transcript"),
      );
      return;
    }
    const nextEntry = cloneCheckpointSessionEntry({
      currentEntry: entry,
      nextSessionFile: restoredSessionFile,
      nextSessionId: restoredSession.getSessionId(),
      preserveCompactionCheckpoints: true,
      totalTokens: checkpoint.tokensBefore,
    });

    await updateSessionStore(storePath, (store) => {
      store[canonicalKey] = nextEntry;
    });

    respond(
      true,
      {
        checkpoint,
        entry: nextEntry,
        key: canonicalKey,
        ok: true,
        sessionId: nextEntry.sessionId,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      reason: "checkpoint-restore",
      sessionKey: canonicalKey,
    });
  },
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const requestedKey = normalizeOptionalString(p.key);
    const agentId = normalizeAgentId(
      normalizeOptionalString(p.agentId) ?? resolveDefaultAgentId(cfg),
    );
    if (requestedKey) {
      const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
      if (requestedAgentId && requestedAgentId !== agentId && normalizeOptionalString(p.agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`,
          ),
        );
        return;
      }
    }
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    let canonicalParentSessionKey: string | undefined;
    if (parentSessionKey) {
      const parent = loadSessionEntry(parentSessionKey);
      if (!parent.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown parent session: ${parentSessionKey}`),
        );
        return;
      }
      canonicalParentSessionKey = parent.canonicalKey;
    }
    const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
    const key = requestedKey
      ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown"
        ? loweredRequestedKey
        : toAgentStoreSessionKey({
            agentId,
            requestKey: requestedKey,
            mainKey: cfg.session?.mainKey,
          })
      : buildDashboardSessionKey(agentId);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const targetAgentId = resolveAgentIdFromSessionKey(target.canonicalKey);
    const created = await updateSessionStore(target.storePath, async (store) => {
      const patched = await applySessionsPatchToStore({
        cfg,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        patch: {
          key: target.canonicalKey,
          label: normalizeOptionalString(p.label),
          model: normalizeOptionalString(p.model),
        },
        store,
        storeKey: target.canonicalKey,
      });
      if (!patched.ok || !canonicalParentSessionKey) {
        return patched;
      }
      const nextEntry: SessionEntry = {
        ...patched.entry,
        parentSessionKey: canonicalParentSessionKey,
      };
      store[target.canonicalKey] = nextEntry;
      return {
        ...patched,
        entry: nextEntry,
      };
    });
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    const ensured = ensureSessionTranscriptFile({
      agentId: targetAgentId,
      sessionFile: created.entry.sessionFile,
      sessionId: created.entry.sessionId,
      storePath: target.storePath,
    });
    if (!ensured.ok) {
      await updateSessionStore(target.storePath, (store) => {
        delete store[target.canonicalKey];
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to create session transcript: ${ensured.error}`),
      );
      return;
    }

    const createdEntry =
      created.entry.sessionFile === ensured.transcriptPath
        ? created.entry
        : {
            ...created.entry,
            sessionFile: ensured.transcriptPath,
          };
    if (createdEntry !== created.entry) {
      await updateSessionStore(target.storePath, (store) => {
        const existing = store[target.canonicalKey];
        if (existing) {
          store[target.canonicalKey] = {
            ...existing,
            sessionFile: ensured.transcriptPath,
          };
        }
      });
    }

    const initialMessage = resolveOptionalInitialSessionMessage(p);
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const messageSeq = initialMessage
      ? readSessionMessages(createdEntry.sessionId, target.storePath, createdEntry.sessionFile)
          .length + 1
      : undefined;

    if (initialMessage) {
      await chatHandlers["chat.send"]({
        client,
        context,
        isWebchatConnect,
        params: {
          idempotencyKey: randomUUID(),
          message: initialMessage,
          sessionKey: target.canonicalKey,
        },
        req,
        respond: (ok, payload, error, meta) => {
          if (ok && payload && typeof payload === "object") {
            runPayload = payload as Record<string, unknown>;
          } else {
            runError = error;
          }
          runMeta = meta;
        },
      });
    }

    const runStarted =
      runPayload !== undefined &&
      shouldAttachPendingMessageSeq({
        cached: runMeta?.cached === true,
        payload: runPayload,
      });

    respond(
      true,
      {
        entry: createdEntry,
        key: target.canonicalKey,
        ok: true,
        runStarted,
        sessionId: createdEntry.sessionId,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      reason: "create",
      sessionKey: target.canonicalKey,
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        reason: "send",
        sessionKey: target.canonicalKey,
      });
    }
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect, context }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;
    const {
      archiveSessionTranscriptsForSessionDetailed,
      cleanupSessionBeforeMutation,
      emitGatewaySessionEndPluginHook,
      emitSessionUnboundLifecycleEvent,
    } = await import("./sessions.runtime.js");

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      canonicalKey,
      cfg,
      entry,
      key,
      legacyKey,
      reason: "session-delete",
      target,
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archivedTranscripts =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSessionDetailed({
            agentId: target.agentId,
            reason: "deleted",
            sessionFile: entry?.sessionFile,
            sessionId,
            storePath,
          })
        : [];
    const archived = archivedTranscripts.map((entry) => entry.archivedPath);
    if (deleted) {
      emitGatewaySessionEndPluginHook({
        agentId: target.agentId,
        archivedTranscripts,
        cfg,
        reason: "deleted",
        sessionFile: entry?.sessionFile,
        sessionId,
        sessionKey: target.canonicalKey ?? key,
        storePath,
      });
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        emitHooks: emitLifecycleHooks,
        reason: "session-delete",
        targetSessionKey: target.canonicalKey ?? key,
      });
    }

    respond(true, { archived, deleted, key: target.canonicalKey, ok: true }, undefined);
    if (deleted) {
      emitSessionsChanged(context, {
        reason: "delete",
        sessionKey: target.canonicalKey,
      });
    }
  },
  "sessions.get": ({ params, respond }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const store = loadSessionStore(storePath);
    const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const messages = limit < allMessages.length ? allMessages.slice(-limit) : allMessages;
    respond(true, { messages }, undefined);
  },
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      opts: p,
      store,
      storePath,
    });
    respond(true, result, undefined);
  },
  "sessions.messages.subscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.subscribeSessionMessageEvents(connId, canonicalKey);
      respond(true, { key: canonicalKey, subscribed: true }, undefined);
      return;
    }
    respond(true, { key: canonicalKey, subscribed: false }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, canonicalKey);
    }
    respond(true, { key: canonicalKey, subscribed: false }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        patch: p,
        store,
        storeKey: primaryKey,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }

    if (hasInternalHookListeners("session", "patch")) {
      const hookContext: SessionPatchHookContext = structuredClone({
        cfg,
        patch: p,
        sessionEntry: applied.entry,
      });
      const hookEvent: SessionPatchHookEvent = {
        action: "patch",
        context: hookContext,
        messages: [],
        sessionKey: target.canonicalKey ?? key,
        timestamp: new Date(),
        type: "session",
      };
      void triggerInternalHook(hookEvent);
    }

    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      entry: applied.entry,
      key: target.canonicalKey,
      ok: true,
      path: storePath,
      resolved: {
        model: resolved.model,
        modelProvider: resolved.provider,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      reason: "patch",
      sessionKey: target.canonicalKey,
    });
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => normalizeOptionalString(String(key ?? "")))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { previews: [], ts: Date.now() } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
        if (!entry?.sessionId) {
          previews.push({ items: [], key, status: "missing" });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          items,
          key,
          status: items.length > 0 ? "ok" : "empty",
        });
      } catch {
        previews.push({ items: [], key, status: "error" });
      }
    }

    respond(true, { previews, ts: Date.now() } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.reset": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const { performGatewaySessionReset } = await import("./sessions.runtime.js");
    const result = await performGatewaySessionReset({
      commandSource: "gateway:sessions.reset",
      key,
      reason,
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { entry: result.entry, key: result.key, ok: true }, undefined);
    emitSessionsChanged(context, {
      reason,
      sessionKey: result.key,
    });
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { key: resolved.key, ok: true }, undefined);
  },
  "sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      client,
      context,
      interruptIfActive: false,
      isWebchatConnect,
      method: "sessions.send",
      params,
      req,
      respond,
    });
  },
  "sessions.steer": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      client,
      context,
      interruptIfActive: true,
      isWebchatConnect,
      method: "sessions.steer",
      params,
      req,
      respond,
    });
  },
  "sessions.subscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.subscribeSessionEvents(connId);
    }
    respond(true, { subscribed: Boolean(connId) }, undefined);
  },
  "sessions.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeSessionEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
};
