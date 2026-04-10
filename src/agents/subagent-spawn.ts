import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import {
  isCronSessionKey,
  isValidAgentId,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { BootstrapContextMode } from "./bootstrap-files.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import {
  type SubagentAttachmentReceiptFile,
  decodeStrictBase64,
  materializeSubagentAttachments,
} from "./subagent-attachments.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagent-spawn-plan.js";
import {
  ADMIN_SCOPE,
  AGENT_LANE_SUBAGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  buildSubagentSystemPrompt,
  callGateway,
  emitSessionLifecycleEvent,
  getGlobalHookRunner,
  isAdminOnlyMethod,
  loadConfig,
  mergeSessionEntry,
  normalizeDeliveryContext,
  pruneLegacyStoreKeys,
  resolveAgentConfig,
  resolveDisplaySessionKey,
  resolveGatewaySessionStoreTarget,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSandboxRuntimeStatus,
  updateSessionStore,
} from "./subagent-spawn.runtime.js";

export const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];
export const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];

export { decodeStrictBase64 };

interface SubagentSpawnDeps {
  callGateway: typeof callGateway;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  loadConfig: typeof loadConfig;
  updateSessionStore: typeof updateSessionStore;
}

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  getGlobalHookRunner,
  loadConfig,
  updateSessionStore,
};

let subagentSpawnDeps: SubagentSpawnDeps = defaultSubagentSpawnDeps;

export interface SpawnSubagentParams {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  attachments?: {
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }[];
  attachMountPath?: string;
}

export interface SpawnSubagentContext {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  requesterAgentIdOverride?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
}

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Wait for completion events to arrive as user messages, track expected child session keys, and only send your final answer after ALL expected completions arrive. If a child completion event arrives AFTER your final answer, reply ONLY with NO_REPLY.";
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

export interface SpawnSubagentResult {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  note?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: { name: string; bytes: number; sha256: string }[];
    relDir: string;
  };
}

export { splitModelRef } from "./subagent-spawn-plan.js";

async function updateSubagentSessionStore(
  storePath: string,
  mutator: Parameters<typeof updateSessionStore>[1],
) {
  return await subagentSpawnDeps.updateSessionStore(storePath, mutator);
}

async function callSubagentGateway(
  params: Parameters<typeof callGateway>[0],
): Promise<Awaited<ReturnType<typeof callGateway>>> {
  // Subagent lifecycle requires methods spanning multiple scope tiers
  // (sessions.patch / sessions.delete → admin, agent → write).  When each call
  // Independently negotiates least-privilege scopes the first connection pairs
  // At a lower tier and every subsequent higher-tier call triggers a
  // Scope-upgrade handshake that headless gateway-client connections cannot
  // Complete interactively, causing close(1008) "pairing required" (#59428).
  //
  // Only admin-only methods are pinned to ADMIN_SCOPE; other methods (e.g.
  // "agent" → write) keep their least-privilege scope so that the gateway does
  // Not treat the caller as owner (senderIsOwner) and expose owner-only tools.
  const scopes = params.scopes ?? (isAdminOnlyMethod(params.method) ? [ADMIN_SCOPE] : undefined);
  return await subagentSpawnDeps.callGateway({
    ...params,
    ...(scopes != null ? { scopes } : {}),
  });
}

function readGatewayRunId(response: Awaited<ReturnType<typeof callGateway>>): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { runId } = response as { runId?: unknown };
  return typeof runId === "string" && runId ? runId : undefined;
}

function loadSubagentConfig() {
  return subagentSpawnDeps.loadConfig();
}

async function persistInitialChildSessionRuntimeModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  childSessionKey: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const { provider, model } = splitModelRef(params.resolvedModel);
  if (!model) {
    return undefined;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.childSessionKey,
    });
    await updateSubagentSessionStore(target.storePath, (store) => {
      pruneLegacyStoreKeys({
        candidates: target.storeKeys,
        canonicalKey: target.canonicalKey,
        store,
      });
      store[target.canonicalKey] = mergeSessionEntry(store[target.canonicalKey], {
        model,
        ...(provider ? { modelProvider: provider } : {}),
      });
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : (typeof error === "string" ? error : "error");
  }
}

function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  // Prevent prompt injection via control/newline characters in system prompt hints.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001F\u007F\u0085\u2028\u2029]/.test(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<void> {
  try {
    await callSubagentGateway({
      method: "sessions.delete",
      params: {
        deleteTranscript: options?.deleteTranscript === true,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        key: childSessionKey,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
}): Promise<void> {
  if (params.attachmentAbsDir) {
    try {
      await fs.rm(params.attachmentAbsDir, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  await cleanupProvisionalSession(params.childSessionKey, {
    deleteTranscript: params.deleteTranscript,
    emitLifecycleHooks: params.emitLifecycleHooks,
  });
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnSubagentMode;
  threadRequested: boolean;
}): SpawnSubagentMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

async function ensureThreadBindingForSubagentSpawn(params: {
  hookRunner: SubagentLifecycleHookRunner | null;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<{ status: "ok" } | { status: "error"; error: string }> {
  const {hookRunner} = params;
  if (!hookRunner?.hasHooks("subagent_spawning")) {
    return {
      error:
        "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.",
      status: "error",
    };
  }

  try {
    const result = await hookRunner.runSubagentSpawning(
      {
        agentId: params.agentId,
        childSessionKey: params.childSessionKey,
        label: params.label,
        mode: params.mode,
        requester: params.requester,
        threadRequested: true,
      },
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    if (result?.status === "error") {
      const error = result.error.trim();
      return {
        error: error || "Failed to prepare thread binding for this subagent session.",
        status: "error",
      };
    }
    if (result?.status !== "ok" || !result.threadBindingReady) {
      return {
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
        status: "error",
      };
    }
    return { status: "ok" };
  } catch (error) {
    return {
      error: `Thread bind failed: ${summarizeError(error)}`,
      status: "error",
    };
  }
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const {task} = params;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId?.trim();

  // Reject malformed agentId before normalizeAgentId can mangle it.
  // Without this gate, error-message strings like "Agent not found: xyz" pass
  // Through normalizeAgentId and become "agent-not-found--xyz", which later
  // Creates ghost workspace directories and triggers cascading cron loops (#31311).
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return {
      error: `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}. Use agents_list to discover valid targets.`,
      status: "error",
    };
  }
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return {
      error: 'mode="session" requires thread=true so the subagent can stay bound to a thread.',
      status: "error",
    };
  }
  const cleanup =
    spawnMode === "session"
      ? "keep"
      : (params.cleanup === "keep" || params.cleanup === "delete"
        ? params.cleanup
        : "keep");
  const expectsCompletionMessage = params.expectsCompletionMessage !== false;
  const requesterOrigin = normalizeDeliveryContext({
    accountId: ctx.agentAccountId,
    channel: ctx.agentChannel,
    threadId: ctx.agentThreadId,
    to: ctx.agentTo,
  });
  const hookRunner = subagentSpawnDeps.getGlobalHookRunner();
  const cfg = loadSubagentConfig();

  // When agent omits runTimeoutSeconds, use the config default.
  // Falls back to 0 (no timeout) if config key is also unset,
  // Preserving current behavior for existing deployments.
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  let modelApplied = false;
  let threadBindingReady = false;
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        alias,
        key: requesterSessionKey,
        mainKey,
      })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    alias,
    key: requesterInternalKey,
    mainKey,
  });

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxSpawnDepth) {
    return {
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
      status: "forbidden",
    };
  }

  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
      status: "forbidden",
    };
  }

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const requireAgentId =
    resolveAgentConfig(cfg, requesterAgentId)?.subagents?.requireAgentId ??
    cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !requestedAgentId?.trim()) {
    return {
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Use agents_list to see allowed agent ids.",
      status: "forbidden",
    };
  }
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  if (targetAgentId !== requesterAgentId) {
    const allowAgents =
      resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
      cfg?.agents?.defaults?.subagents?.allowAgents ??
      [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const normalizedTargetId = normalizeLowercaseStringOrEmpty(targetAgentId);
    const allowSet = new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeLowercaseStringOrEmpty(normalizeAgentId(value))),
    );
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      const allowedText = allowSet.size > 0 ? [...allowSet].join(", ") : "none";
      return {
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
        status: "forbidden",
      };
    }
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: requesterInternalKey,
  });
  const childRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: childSessionKey,
  });
  if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
    if (requesterRuntime.sandboxed) {
      return {
        error:
          "Sandboxed sessions cannot spawn unsandboxed subagents. Set a sandboxed target agent or use the same agent runtime.",
        status: "forbidden",
      };
    }
    return {
      error:
        'sessions_spawn sandbox="require" needs a sandboxed target runtime. Pick a sandboxed agentId or use sandbox="inherit".',
      status: "forbidden",
    };
  }
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const childCapabilities = resolveSubagentCapabilities({
    depth: childDepth,
    maxSpawnDepth,
  });
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const plan = resolveSubagentModelAndThinkingPlan({
    cfg,
    modelOverride,
    targetAgentConfig,
    targetAgentId,
    thinkingOverrideRaw,
  });
  if (plan.status === "error") {
    return {
      error: plan.error,
      status: "error",
    };
  }
  const { resolvedModel, thinkingOverride } = plan;
  const patchChildSession = async (patch: Record<string, unknown>): Promise<string | undefined> => {
    try {
      await callSubagentGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, ...patch },
        timeoutMs: 10_000,
      });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : (typeof error === "string" ? error : "error");
    }
  };

  const initialChildSessionPatch: Record<string, unknown> = {
    spawnDepth: childDepth,
    subagentControlScope: childCapabilities.controlScope,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    ...plan.initialSessionPatch,
  };

  const initialPatchError = await patchChildSession(initialChildSessionPatch);
  if (initialPatchError) {
    return {
      childSessionKey,
      error: initialPatchError,
      status: "error",
    };
  }
  if (resolvedModel) {
    const runtimeModelPersistError = await persistInitialChildSessionRuntimeModel({
      cfg,
      childSessionKey,
      resolvedModel,
    });
    if (runtimeModelPersistError) {
      try {
        await callSubagentGateway({
          method: "sessions.delete",
          params: { emitLifecycleHooks: false, key: childSessionKey },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort cleanup only.
      }
      return {
        childSessionKey,
        error: runtimeModelPersistError,
        status: "error",
      };
    }
    modelApplied = true;
  }
  if (requestThreadBinding) {
    const bindResult = await ensureThreadBindingForSubagentSpawn({
      agentId: targetAgentId,
      childSessionKey,
      hookRunner,
      label: label || undefined,
      mode: spawnMode,
      requester: {
        accountId: requesterOrigin?.accountId,
        channel: requesterOrigin?.channel,
        threadId: requesterOrigin?.threadId,
        to: requesterOrigin?.to,
      },
      requesterSessionKey: requesterInternalKey,
    });
    if (bindResult.status === "error") {
      try {
        await callSubagentGateway({
          method: "sessions.delete",
          params: { emitLifecycleHooks: false, key: childSessionKey },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort cleanup only.
      }
      return {
        childSessionKey,
        error: bindResult.error,
        status: "error",
      };
    }
    threadBindingReady = true;
  }
  const mountPathHint = sanitizeMountPathHint(params.attachMountPath);

  let childSystemPrompt = buildSubagentSystemPrompt({
    acpEnabled: cfg.acp?.enabled !== false && !childRuntime.sandboxed,
    childDepth,
    childSessionKey,
    label: label || undefined,
    maxSpawnDepth,
    requesterOrigin,
    requesterSessionKey,
    task,
  });

  let retainOnSessionKeep = false;
  let attachmentsReceipt:
    | {
        count: number;
        totalBytes: number;
        files: SubagentAttachmentReceiptFile[];
        relDir: string;
      }
    | undefined;
  let attachmentAbsDir: string | undefined;
  let attachmentRootDir: string | undefined;
  const materializedAttachments = await materializeSubagentAttachments({
    attachments: params.attachments,
    config: cfg,
    mountPathHint,
    targetAgentId,
  });
  if (materializedAttachments && materializedAttachments.status !== "ok") {
    await cleanupProvisionalSession(childSessionKey, {
      deleteTranscript: true,
      emitLifecycleHooks: threadBindingReady,
    });
    return {
      error: materializedAttachments.error,
      status: materializedAttachments.status,
    };
  }
  if (materializedAttachments?.status === "ok") {
    ({ retainOnSessionKeep } = materializedAttachments);
    attachmentsReceipt = materializedAttachments.receipt;
    attachmentAbsDir = materializedAttachments.absDir;
    attachmentRootDir = materializedAttachments.rootDir;
    childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
  }

  const bootstrapContextMode: BootstrapContextMode | undefined = params.lightContext
    ? "lightweight"
    : undefined;

  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    spawnMode === "session"
      ? "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages."
      : undefined,
    `[Subagent Task]: ${task}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupChannel: ctx.agentGroupChannel,
    agentGroupId: ctx.agentGroupId,
    agentGroupSpace: ctx.agentGroupSpace,
    workspaceDir: ctx.workspaceDir,
  });
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: spawnedByKey,
    ...toolSpawnMetadata,
    workspaceDir: resolveSpawnedWorkspaceInheritance({
      config: cfg,
      targetAgentId,
      // For cross-agent spawns, ignore the caller's inherited workspace;
      // Let targetAgentId resolve the correct workspace instead.
      explicitWorkspaceDir:
        targetAgentId !== requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir,
    }),
  });
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
    ...(spawnedMetadata.workspaceDir ? { spawnedWorkspaceDir: spawnedMetadata.workspaceDir } : {}),
  });
  if (spawnLineagePatchError) {
    await cleanupFailedSpawnBeforeAgentStart({
      attachmentAbsDir,
      childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: threadBindingReady,
    });
    return {
      childSessionKey,
      error: spawnLineagePatchError,
      status: "error",
    };
  }

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const {
      spawnedBy: _spawnedBy,
      workspaceDir: _workspaceDir,
      ...publicSpawnedMetadata
    } = spawnedMetadata;
    const response = await callSubagentGateway({
      method: "agent",
      params: {
        accountId: requesterOrigin?.accountId ?? undefined,
        channel: requesterOrigin?.channel,
        deliver: false,
        extraSystemPrompt: childSystemPrompt,
        idempotencyKey: childIdem,
        label: label || undefined,
        lane: AGENT_LANE_SUBAGENT,
        message: childTaskMessage,
        sessionKey: childSessionKey,
        thinking: thinkingOverride,
        threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
        timeout: runTimeoutSeconds,
        to: requesterOrigin?.to ?? undefined,
        ...(bootstrapContextMode
          ? {
              bootstrapContextMode,
              bootstrapContextRunKind: "default" as const,
            }
          : {}),
        ...publicSpawnedMetadata,
      },
      timeoutMs: 10_000,
    });
    const runId = readGatewayRunId(response);
    if (runId) {
      childRunId = runId;
    }
  } catch (error) {
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    let emitLifecycleHooks = false;
    if (threadBindingReady) {
      const hasEndedHook = hookRunner?.hasHooks("subagent_ended") === true;
      let endedHookEmitted = false;
      if (hasEndedHook) {
        try {
          await hookRunner?.runSubagentEnded(
            {
              accountId: requesterOrigin?.accountId,
              error: "Session failed to start",
              outcome: "error",
              reason: "spawn-failed",
              runId: childRunId,
              sendFarewell: true,
              targetKind: "subagent",
              targetSessionKey: childSessionKey,
            },
            {
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              runId: childRunId,
            },
          );
          endedHookEmitted = true;
        } catch {
          // Spawn should still return an actionable error even if cleanup hooks fail.
        }
      }
      emitLifecycleHooks = !endedHookEmitted;
    }
    // Always delete the provisional child session after a failed spawn attempt.
    // If we already emitted subagent_ended above, suppress a duplicate lifecycle hook.
    try {
      await callSubagentGateway({
        method: "sessions.delete",
        params: {
          deleteTranscript: true,
          emitLifecycleHooks,
          key: childSessionKey,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort only.
    }
    const messageText = summarizeError(error);
    return {
      childSessionKey,
      error: messageText,
      runId: childRunId,
      status: "error",
    };
  }

  try {
    registerSubagentRun({
      attachmentsDir: attachmentAbsDir,
      attachmentsRootDir: attachmentRootDir,
      childSessionKey,
      cleanup,
      controllerSessionKey: requesterInternalKey,
      expectsCompletionMessage,
      label: label || undefined,
      model: resolvedModel,
      requesterDisplayKey,
      requesterOrigin,
      requesterSessionKey: requesterInternalKey,
      retainAttachmentsOnKeep: retainOnSessionKeep,
      runId: childRunId,
      runTimeoutSeconds,
      spawnMode,
      task,
      workspaceDir: spawnedMetadata.workspaceDir,
    });
  } catch (error) {
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      await callSubagentGateway({
        method: "sessions.delete",
        params: {
          deleteTranscript: true,
          emitLifecycleHooks: threadBindingReady,
          key: childSessionKey,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort cleanup only.
    }
    return {
      childSessionKey,
      error: `Failed to register subagent run: ${summarizeError(error)}`,
      runId: childRunId,
      status: "error",
    };
  }

  if (hookRunner?.hasHooks("subagent_spawned")) {
    try {
      await hookRunner.runSubagentSpawned(
        {
          agentId: targetAgentId,
          childSessionKey,
          label: label || undefined,
          mode: spawnMode,
          requester: {
            accountId: requesterOrigin?.accountId,
            channel: requesterOrigin?.channel,
            threadId: requesterOrigin?.threadId,
            to: requesterOrigin?.to,
          },
          runId: childRunId,
          threadRequested: requestThreadBinding,
        },
        {
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
          runId: childRunId,
        },
      );
    } catch {
      // Spawn should still return accepted if spawn lifecycle hooks fail.
    }
  }

  // Emit lifecycle event so the gateway can broadcast sessions.changed to SSE subscribers.
  emitSessionLifecycleEvent({
    label: label || undefined,
    parentSessionKey: requesterInternalKey,
    reason: "create",
    sessionKey: childSessionKey,
  });

  // Check if we're in a cron isolated session - don't add "do not poll" note
  // Because cron sessions end immediately after the agent produces a response,
  // So the agent needs to wait for subagent results to keep the turn alive.
  const isCronSession = isCronSessionKey(ctx.agentSessionKey);
  const note =
    spawnMode === "session"
      ? SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE
      : (isCronSession
        ? undefined
        : SUBAGENT_SPAWN_ACCEPTED_NOTE);

  return {
    attachments: attachmentsReceipt,
    childSessionKey,
    mode: spawnMode,
    modelApplied: resolvedModel ? modelApplied : undefined,
    note,
    runId: childRunId,
    status: "accepted",
  };
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    subagentSpawnDeps = overrides
      ? {
          ...defaultSubagentSpawnDeps,
          ...overrides,
        }
      : defaultSubagentSpawnDeps;
  },
};
