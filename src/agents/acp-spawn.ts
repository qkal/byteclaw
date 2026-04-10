import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  type AcpSpawnRuntimeCloseHandle,
  cleanupFailedAcpSpawn,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../acp/runtime/session-identifiers.js";
import type { AcpRuntimeSessionMode } from "../acp/runtime/types.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { callGateway } from "../gateway/call.js";
import { areHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import {
  type SessionBindingRecord,
  getSessionBindingService,
  isSessionBindingError,
} from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import {
  deliveryContextFromSession,
  formatConversationTarget,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  type AcpSpawnParentRelayHandle,
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveSpawnedWorkspaceInheritance } from "./spawned-context.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

const log = createSubsystemLogger("agents/acp-spawn");

export const ACP_SPAWN_MODES = ["run", "session"] as const;
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
export const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];
export const ACP_SPAWN_STREAM_TARGETS = ["parent"] as const;
export type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];

export interface SpawnAcpParams {
  task: string;
  label?: string;
  agentId?: string;
  resumeSessionId?: string;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  streamTo?: SpawnAcpStreamTarget;
}

export interface SpawnAcpContext {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
  agentGroupId?: string;
  sandboxed?: boolean;
}

export const ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "thread_required",
  "target_agent_required",
  "agent_forbidden",
  "cwd_resolution_failed",
  "thread_binding_invalid",
  "spawn_failed",
  "dispatch_failed",
] as const;
export type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];

interface SpawnAcpResultFields {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  streamLogPath?: string;
  note?: string;
}

type SpawnAcpAcceptedResult = SpawnAcpResultFields & {
  status: "accepted";
  childSessionKey: string;
  runId: string;
  mode: SpawnAcpMode;
};

type SpawnAcpFailedResult = SpawnAcpResultFields & {
  status: "forbidden" | "error";
  error: string;
  errorCode: SpawnAcpErrorCode;
};

export type SpawnAcpResult = SpawnAcpAcceptedResult | SpawnAcpFailedResult;

export function isSpawnAcpAcceptedResult(result: SpawnAcpResult): result is SpawnAcpAcceptedResult {
  return result.status === "accepted";
}

export const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: SpawnAcpSandboxMode;
}): string | undefined {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  if (requesterSandboxed) {
    return 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.';
  }
  if (sandboxMode === "require") {
    return 'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".';
  }
  return undefined;
}

interface PreparedAcpThreadBinding {
  channel: string;
  accountId: string;
  placement: "current" | "child";
  conversationId: string;
}

type AcpSpawnInitializedSession = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

interface AcpSpawnInitializedRuntime {
  initialized: AcpSpawnInitializedSession;
  runtimeCloseHandle: AcpSpawnRuntimeCloseHandle;
  sessionId?: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
}

interface AcpSpawnRequesterState {
  parentSessionKey?: string;
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  heartbeatEnabled: boolean;
  heartbeatRelayRouteUsable: boolean;
  origin: ReturnType<typeof normalizeDeliveryContext>;
}

interface AcpSpawnStreamPlan {
  implicitStreamToParent: boolean;
  effectiveStreamToParent: boolean;
}

interface AcpSpawnBootstrapDeliveryPlan {
  useInlineDelivery: boolean;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
}

function resolvePlacementWithoutChannelPlugin(params: {
  channel: string;
  capabilities: { placements: ("current" | "child")[] };
}): "current" | "child" {
  switch (params.channel) {
    case "discord":
    case "matrix": {
      return params.capabilities.placements.includes("child") ? "child" : "current";
    }
    case "line":
    case "telegram": {
      return "current";
    }
  }
  return params.capabilities.placements.includes("child") ? "child" : "current";
}

function normalizeLineConversationIdFallback(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.match(/^line:(?:(?:user|group|room):)?(.+)$/i)?.[1]?.trim() ?? trimmed;
  return normalized ? normalized : undefined;
}

function normalizeTelegramConversationIdFallback(params: {
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): string | undefined {
  const explicitGroupId = normalizeOptionalString(params.groupId);
  const explicitThreadId =
    params.threadId != null ? normalizeOptionalString(String(params.threadId)) : undefined;
  if (
    explicitGroupId &&
    explicitThreadId &&
    /^-?\d+$/.test(explicitGroupId) &&
    /^\d+$/.test(explicitThreadId)
  ) {
    return `${explicitGroupId}:topic:${explicitThreadId}`;
  }

  const trimmed = normalizeOptionalString(params.to) ?? "";
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^telegram:(?:group:|channel:|direct:)?/i, "");
  const topicMatch = /^(-?\d+):topic:(\d+)$/i.exec(normalized);
  if (topicMatch?.[1] && topicMatch[2]) {
    return `${topicMatch[1]}:topic:${topicMatch[2]}`;
  }
  return /^-?\d+$/.test(normalized) ? normalized : undefined;
}

const threadBindingFallbackConversationResolvers = {
  line: (params: { to?: string; groupId?: string }) =>
    normalizeLineConversationIdFallback(params.groupId ?? params.to),
  telegram: (params: { to?: string; threadId?: string | number; groupId?: string }) =>
    normalizeTelegramConversationIdFallback(params),
} as const;

function resolveSpawnMode(params: {
  requestedMode?: SpawnAcpMode;
  threadRequested: boolean;
}): SpawnAcpMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function resolveAcpSessionMode(mode: SpawnAcpMode): AcpRuntimeSessionMode {
  return mode === "session" ? "persistent" : "oneshot";
}

function isHeartbeatEnabledForSessionAgent(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  const requesterAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!requesterAgentId) {
    return true;
  }

  const agentEntries = params.cfg.agents?.list ?? [];
  const hasExplicitHeartbeatAgents = agentEntries.some((entry) => Boolean(entry?.heartbeat));
  const enabledByPolicy = hasExplicitHeartbeatAgents
    ? agentEntries.some(
        (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === requesterAgentId,
      )
    : requesterAgentId === resolveDefaultAgentId(params.cfg);
  if (!enabledByPolicy) {
    return false;
  }

  const heartbeatEvery =
    resolveAgentConfig(params.cfg, requesterAgentId)?.heartbeat?.every ??
    params.cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmedEvery = normalizeOptionalString(heartbeatEvery) ?? "";
  if (!trimmedEvery) {
    return false;
  }
  try {
    return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

function resolveHeartbeatConfigForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["heartbeat"] {
  const defaults = params.cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(params.cfg, params.agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return undefined;
  }
  return {
    ...defaults,
    ...overrides,
  };
}

function hasSessionLocalHeartbeatRelayRoute(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  requesterAgentId: string;
}): boolean {
  const scope = params.cfg.session?.scope ?? "per-sender";
  if (scope === "global") {
    return false;
  }

  const heartbeat = resolveHeartbeatConfigForAgent({
    agentId: params.requesterAgentId,
    cfg: params.cfg,
  });
  if ((heartbeat?.target ?? "none") !== "last") {
    return false;
  }

  // Explicit delivery overrides are not session-local and can route updates
  // To unrelated destinations (for example a pinned ops channel).
  if (normalizeOptionalString(heartbeat?.to)) {
    return false;
  }
  if (normalizeOptionalString(heartbeat?.accountId)) {
    return false;
  }

  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.requesterAgentId,
  });
  const sessionStore = loadSessionStore(storePath);
  const parentEntry = sessionStore[params.parentSessionKey];
  const parentDeliveryContext = deliveryContextFromSession(parentEntry);
  return Boolean(parentDeliveryContext?.channel && parentDeliveryContext.to);
}

function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): { ok: true; agentId: string } | { ok: false; error: string } {
  const requested = normalizeOptionalAgentId(params.requestedAgentId);
  if (requested) {
    return { agentId: requested, ok: true };
  }

  const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (configuredDefault) {
    return { agentId: configuredDefault, ok: true };
  }

  return {
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
    ok: false,
  };
}

function normalizeOptionalAgentId(value: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
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

function createAcpSpawnFailure(params: {
  status: "forbidden" | "error";
  errorCode: SpawnAcpErrorCode;
  error: string;
  childSessionKey?: string;
}): SpawnAcpFailedResult {
  return {
    error: params.error,
    errorCode: params.errorCode,
    status: params.status,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
  };
}

function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolveRuntimeCwdForAcpSpawn(params: {
  resolvedCwd?: string;
  explicitCwd?: string;
}): Promise<string | undefined> {
  if (!params.resolvedCwd) {
    return undefined;
  }
  if (normalizeOptionalString(params.explicitCwd)) {
    return params.resolvedCwd;
  }
  try {
    await fs.access(params.resolvedCwd);
    return params.resolvedCwd;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveRequesterInternalSessionKey(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): string {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  return requesterSessionKey
    ? resolveInternalSessionKey({
        alias,
        key: requesterSessionKey,
        mainKey,
      })
    : alias;
}

async function persistAcpSpawnSessionFileBestEffort(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  agentId: string;
  threadId?: string | number;
  stage: "spawn" | "thread-bind";
}): Promise<SessionEntry | undefined> {
  try {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      threadId: params.threadId,
    });
    return resolvedSessionFile.sessionEntry;
  } catch (error) {
    log.warn(
      `ACP session-file persistence failed during ${params.stage} for ${params.sessionKey}: ${summarizeError(error)}`,
    );
    return params.sessionEntry;
  }
}

function resolveConversationIdForThreadBinding(params: {
  channel?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): string | undefined {
  const channel = normalizeOptionalLowercaseString(params.channel);
  const normalizedChannelId = channel ? normalizeChannelId(channel) : null;
  const channelKey = normalizedChannelId ?? channel ?? null;
  const pluginResolvedConversationId = normalizedChannelId
    ? getChannelPlugin(normalizedChannelId)?.messaging?.resolveInboundConversation?.({
        conversationId: params.groupId ?? params.to,
        isGroup: true,
        threadId: params.threadId,
        to: params.groupId ?? params.to,
      })?.conversationId
    : null;
  if (normalizeOptionalString(pluginResolvedConversationId)) {
    return normalizeOptionalString(pluginResolvedConversationId);
  }
  const compatibilityConversationId =
    channelKey && Object.hasOwn(threadBindingFallbackConversationResolvers, channelKey)
      ? threadBindingFallbackConversationResolvers[
          channelKey as keyof typeof threadBindingFallbackConversationResolvers
        ](params)
      : undefined;
  if (compatibilityConversationId) {
    return compatibilityConversationId;
  }
  const genericConversationId = resolveConversationIdFromTargets({
    targets: [params.to],
    threadId: params.threadId,
  });
  if (genericConversationId) {
    return genericConversationId;
  }
  return undefined;
}

function resolveAcpSpawnChannelAccountId(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): string | undefined {
  const channel = normalizeOptionalLowercaseString(params.channel);
  const explicitAccountId = normalizeOptionalString(params.accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  if (!channel) {
    return undefined;
  }
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
  return normalizeOptionalString(configuredDefaultAccountId) ?? "default";
}

function prepareAcpThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): { ok: true; binding: PreparedAcpThreadBinding } | { ok: false; error: string } {
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return {
      error: "thread=true for ACP sessions requires a channel context.",
      ok: false,
    };
  }

  const accountId = resolveAcpSpawnChannelAccountId({
    accountId: params.accountId,
    cfg: params.cfg,
    channel,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    accountId,
    cfg: params.cfg,
    channel,
    kind: "acp",
  });
  if (!policy.enabled) {
    return {
      error: formatThreadBindingDisabledError({
        accountId: policy.accountId,
        channel: policy.channel,
        kind: "acp",
      }),
      ok: false,
    };
  }
  if (!policy.spawnEnabled) {
    return {
      error: formatThreadBindingSpawnDisabledError({
        accountId: policy.accountId,
        channel: policy.channel,
        kind: "acp",
      }),
      ok: false,
    };
  }
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    accountId: policy.accountId,
    channel: policy.channel,
  });
  if (!capabilities.adapterAvailable) {
    return {
      error: `Thread bindings are unavailable for ${policy.channel}.`,
      ok: false,
    };
  }
  const pluginPlacement = getChannelPlugin(policy.channel)?.conversationBindings
    ?.defaultTopLevelPlacement;
  const placementToUse =
    pluginPlacement ??
    resolvePlacementWithoutChannelPlugin({
      capabilities,
      channel: policy.channel,
    });
  if (!capabilities.bindSupported || !capabilities.placements.includes(placementToUse)) {
    return {
      error: `Thread bindings do not support ${placementToUse} placement for ${policy.channel}.`,
      ok: false,
    };
  }
  const conversationIdRaw = resolveConversationIdForThreadBinding({
    channel: policy.channel,
    groupId: params.groupId,
    threadId: params.threadId,
    to: params.to,
  });
  if (!conversationIdRaw) {
    return {
      error: `Could not resolve a ${policy.channel} conversation for ACP thread spawn.`,
      ok: false,
    };
  }

  return {
    binding: {
      accountId: policy.accountId,
      channel: policy.channel,
      conversationId: conversationIdRaw,
      placement: placementToUse,
    },
    ok: true,
  };
}

function resolveAcpSpawnRequesterState(params: {
  cfg: OpenClawConfig;
  parentSessionKey?: string;
  ctx: SpawnAcpContext;
}): AcpSpawnRequesterState {
  const bindingService = getSessionBindingService();
  const requesterParsedSession = parseAgentSessionKey(params.parentSessionKey);
  const isSubagentSession =
    Boolean(requesterParsedSession) && isSubagentSessionKey(params.parentSessionKey);
  const hasActiveSubagentBinding =
    isSubagentSession && params.parentSessionKey
      ? bindingService
          .listBySession(params.parentSessionKey)
          .some((record) => record.targetKind === "subagent" && record.status !== "ended")
      : false;
  const hasThreadContext =
    typeof params.ctx.agentThreadId === "string"
      ? Boolean(normalizeOptionalString(params.ctx.agentThreadId))
      : params.ctx.agentThreadId != null;
  const requesterAgentId = requesterParsedSession?.agentId;

  return {
    hasActiveSubagentBinding,
    hasThreadContext,
    heartbeatEnabled: isHeartbeatEnabledForSessionAgent({
      cfg: params.cfg,
      sessionKey: params.parentSessionKey,
    }),
    heartbeatRelayRouteUsable:
      params.parentSessionKey && requesterAgentId
        ? hasSessionLocalHeartbeatRelayRoute({
            cfg: params.cfg,
            parentSessionKey: params.parentSessionKey,
            requesterAgentId,
          })
        : false,
    isSubagentSession,
    origin: normalizeDeliveryContext({
      accountId: params.ctx.agentAccountId,
      channel: params.ctx.agentChannel,
      threadId: params.ctx.agentThreadId,
      to: params.ctx.agentTo,
    }),
    parentSessionKey: params.parentSessionKey,
  };
}

function resolveAcpSpawnStreamPlan(params: {
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  requester: AcpSpawnRequesterState;
}): AcpSpawnStreamPlan {
  // For mode=run without thread binding, implicitly route output to parent
  // Only for spawned subagent orchestrator sessions with heartbeat enabled
  // AND a session-local heartbeat delivery route (target=last + usable last route).
  // Skip requester sessions that are thread-bound (or carrying thread context)
  // So user-facing threads do not receive unsolicited ACP progress chatter
  // Unless streamTo="parent" is explicitly requested. Use resolved spawnMode
  // (not params.mode) so default mode selection works.
  const implicitStreamToParent =
    !params.streamToParentRequested &&
    params.spawnMode === "run" &&
    !params.requestThreadBinding &&
    params.requester.isSubagentSession &&
    !params.requester.hasActiveSubagentBinding &&
    !params.requester.hasThreadContext &&
    params.requester.heartbeatEnabled &&
    params.requester.heartbeatRelayRouteUsable;

  return {
    effectiveStreamToParent: params.streamToParentRequested || implicitStreamToParent,
    implicitStreamToParent,
  };
}

async function initializeAcpSpawnRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  runtimeMode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
}): Promise<AcpSpawnInitializedRuntime> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.targetAgentId });
  const sessionStore = loadSessionStore(storePath);
  let sessionEntry: SessionEntry | undefined = sessionStore[params.sessionKey];
  const sessionId = sessionEntry?.sessionId;
  if (sessionId) {
    sessionEntry = await persistAcpSpawnSessionFileBestEffort({
      agentId: params.targetAgentId,
      sessionEntry,
      sessionId,
      sessionKey: params.sessionKey,
      sessionStore,
      stage: "spawn",
      storePath,
    });
  }

  const initialized = await getAcpSessionManager().initializeSession({
    agent: params.targetAgentId,
    backendId: params.cfg.acp?.backend,
    cfg: params.cfg,
    cwd: params.cwd,
    mode: params.runtimeMode,
    resumeSessionId: params.resumeSessionId,
    sessionKey: params.sessionKey,
  });

  return {
    initialized,
    runtimeCloseHandle: {
      handle: initialized.handle,
      runtime: initialized.runtime,
    },
    sessionEntry,
    sessionId,
    sessionStore,
    storePath,
  };
}

async function bindPreparedAcpThread(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  label?: string;
  preparedBinding: PreparedAcpThreadBinding;
  initializedRuntime: AcpSpawnInitializedRuntime;
}): Promise<{
  binding: SessionBindingRecord;
  sessionEntry: SessionEntry | undefined;
}> {
  const binding = await getSessionBindingService().bind({
    conversation: {
      accountId: params.preparedBinding.accountId,
      channel: params.preparedBinding.channel,
      conversationId: params.preparedBinding.conversationId,
    },
    metadata: {
      agentId: params.targetAgentId,
      boundBy: "system",
      introText: resolveThreadBindingIntroText({
        agentId: params.targetAgentId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        label: params.label || undefined,
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        sessionCwd: resolveAcpSessionCwd(params.initializedRuntime.initialized.meta),
        sessionDetails: resolveAcpThreadSessionDetailLines({
          sessionKey: params.sessionKey,
          meta: params.initializedRuntime.initialized.meta,
        }),
      }),
      label: params.label || undefined,
      threadName: resolveThreadBindingThreadName({
        agentId: params.targetAgentId,
        label: params.label || params.targetAgentId,
      }),
    },
    placement: params.preparedBinding.placement,
    targetKind: "session",
    targetSessionKey: params.sessionKey,
  });
  if (!binding.conversation.conversationId) {
    throw new Error(
      params.preparedBinding.placement === "child"
        ? `Failed to create and bind a ${params.preparedBinding.channel} thread for this ACP session.`
        : `Failed to bind the current ${params.preparedBinding.channel} conversation for this ACP session.`,
    );
  }

  let {sessionEntry} = params.initializedRuntime;
  if (params.initializedRuntime.sessionId && params.preparedBinding.placement === "child") {
    const boundThreadId = normalizeOptionalString(String(binding.conversation.conversationId));
    if (boundThreadId) {
      sessionEntry = await persistAcpSpawnSessionFileBestEffort({
        agentId: params.targetAgentId,
        sessionEntry,
        sessionId: params.initializedRuntime.sessionId,
        sessionKey: params.sessionKey,
        sessionStore: params.initializedRuntime.sessionStore,
        stage: "thread-bind",
        storePath: params.initializedRuntime.storePath,
        threadId: boundThreadId,
      });
    }
  }

  return { binding, sessionEntry };
}

function resolveAcpSpawnBootstrapDeliveryPlan(params: {
  cfg: OpenClawConfig;
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  effectiveStreamToParent: boolean;
  requester: AcpSpawnRequesterState;
  binding: SessionBindingRecord | null;
}): AcpSpawnBootstrapDeliveryPlan {
  // Child-thread ACP spawns deliver bootstrap output to the new thread; current-conversation
  // Binds deliver back to the originating target.
  const boundThreadIdRaw = params.binding?.conversation.conversationId;
  const boundThreadId = boundThreadIdRaw
    ? normalizeOptionalString(String(boundThreadIdRaw))
    : undefined;
  const fallbackThreadIdRaw = params.requester.origin?.threadId;
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? normalizeOptionalString(String(fallbackThreadIdRaw)) : undefined;
  const deliveryThreadId = boundThreadId ?? fallbackThreadId;
  const requesterConversationId = resolveConversationIdForThreadBinding({
    channel: params.requester.origin?.channel,
    threadId: fallbackThreadId,
    to: params.requester.origin?.to,
  });
  const requesterAccountId = resolveAcpSpawnChannelAccountId({
    accountId: params.requester.origin?.accountId,
    cfg: params.cfg,
    channel: params.requester.origin?.channel,
  });
  const bindingMatchesRequesterConversation = Boolean(
    params.requester.origin?.channel &&
    params.binding?.conversation.channel === params.requester.origin.channel &&
    params.binding?.conversation.accountId === requesterAccountId &&
    requesterConversationId &&
    params.binding?.conversation.conversationId === requesterConversationId,
  );
  const boundDeliveryTarget = resolveConversationDeliveryTarget({
    channel: params.requester.origin?.channel ?? params.binding?.conversation.channel,
    conversationId: params.binding?.conversation.conversationId,
    parentConversationId: params.binding?.conversation.parentConversationId,
  });
  const inferredDeliveryTo =
    (bindingMatchesRequesterConversation
      ? normalizeOptionalString(params.requester.origin?.to)
      : undefined) ??
    boundDeliveryTarget.to ??
    normalizeOptionalString(params.requester.origin?.to) ??
    formatConversationTarget({
      channel: params.requester.origin?.channel,
      conversationId: deliveryThreadId,
    });
  const resolvedDeliveryThreadId = bindingMatchesRequesterConversation
    ? fallbackThreadId
    : (boundDeliveryTarget.threadId ?? deliveryThreadId);
  const hasDeliveryTarget = Boolean(params.requester.origin?.channel && inferredDeliveryTo);

  // Thread-bound session spawns always deliver inline to their bound thread.
  // Background run-mode spawns should stay internal and report back through
  // The parent task lifecycle notifier instead of letting the child ACP
  // Session write raw output directly into the originating channel.
  const useInlineDelivery =
    hasDeliveryTarget && !params.effectiveStreamToParent && params.spawnMode === "session";

  return {
    accountId: useInlineDelivery ? requesterAccountId : undefined,
    channel: useInlineDelivery ? params.requester.origin?.channel : undefined,
    threadId: useInlineDelivery ? resolvedDeliveryThreadId : undefined,
    to: useInlineDelivery ? inferredDeliveryTo : undefined,
    useInlineDelivery,
  };
}

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = loadConfig();
  const requesterInternalKey = resolveRequesterInternalSessionKey({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
  });
  if (!isAcpEnabledByPolicy(cfg)) {
    return createAcpSpawnFailure({
      error: "ACP is disabled by policy (`acp.enabled=false`).",
      errorCode: "acp_disabled",
      status: "forbidden",
    });
  }
  const streamToParentRequested = params.streamTo === "parent";
  const parentSessionKey = normalizeOptionalString(ctx.agentSessionKey);
  if (streamToParentRequested && !parentSessionKey) {
    return createAcpSpawnFailure({
      error: 'sessions_spawn streamTo="parent" requires an active requester session context.',
      errorCode: "requester_session_required",
      status: "error",
    });
  }

  const requestThreadBinding = params.thread === true;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg,
    requesterSandboxed: ctx.sandboxed,
    requesterSessionKey: ctx.agentSessionKey,
    sandbox: params.sandbox,
  });
  if (runtimePolicyError) {
    return createAcpSpawnFailure({
      error: runtimePolicyError,
      errorCode: "runtime_policy",
      status: "forbidden",
    });
  }

  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return createAcpSpawnFailure({
      error: 'mode="session" requires thread=true so the ACP session can stay bound to a thread.',
      errorCode: "thread_required",
      status: "error",
    });
  }

  const requesterState = resolveAcpSpawnRequesterState({
    cfg,
    ctx,
    parentSessionKey,
  });
  const { effectiveStreamToParent } = resolveAcpSpawnStreamPlan({
    requestThreadBinding,
    requester: requesterState,
    spawnMode,
    streamToParentRequested,
  });

  const targetAgentResult = resolveTargetAcpAgentId({
    cfg,
    requestedAgentId: params.agentId,
  });
  if (!targetAgentResult.ok) {
    return createAcpSpawnFailure({
      error: targetAgentResult.error,
      errorCode: "target_agent_required",
      status: "error",
    });
  }
  const targetAgentId = targetAgentResult.agentId;
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return createAcpSpawnFailure({
      error: agentPolicyError.message,
      errorCode: "agent_forbidden",
      status: "forbidden",
    });
  }

  const sessionKey = `agent:${targetAgentId}:acp:${crypto.randomUUID()}`;
  const runtimeMode = resolveAcpSessionMode(spawnMode);
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    explicitWorkspaceDir: params.cwd,
    requesterSessionKey: ctx.agentSessionKey,
    targetAgentId,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      explicitCwd: params.cwd,
      resolvedCwd,
    });
  } catch (error) {
    return createAcpSpawnFailure({
      error: summarizeError(error),
      errorCode: "cwd_resolution_failed",
      status: "error",
    });
  }

  let preparedBinding: PreparedAcpThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = prepareAcpThreadBinding({
      accountId: ctx.agentAccountId,
      cfg,
      channel: ctx.agentChannel,
      groupId: ctx.agentGroupId,
      threadId: ctx.agentThreadId,
      to: ctx.agentTo,
    });
    if (!prepared.ok) {
      return createAcpSpawnFailure({
        error: prepared.error,
        errorCode: "thread_binding_invalid",
        status: "error",
      });
    }
    preparedBinding = prepared.binding;
  }

  let binding: SessionBindingRecord | null = null;
  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        spawnedBy: requesterInternalKey,
        ...(params.label ? { label: params.label } : {}),
      },
      timeoutMs: 10_000,
    });
    sessionCreated = true;
    const initializedSession = await initializeAcpSpawnRuntime({
      cfg,
      cwd: runtimeCwd,
      resumeSessionId: params.resumeSessionId,
      runtimeMode,
      sessionKey,
      targetAgentId,
    });
    initializedRuntime = initializedSession.runtimeCloseHandle;

    if (preparedBinding) {
      ({ binding } = await bindPreparedAcpThread({
        cfg,
        initializedRuntime: initializedSession,
        label: params.label,
        preparedBinding,
        sessionKey,
        targetAgentId,
      }));
    }
  } catch (error) {
    await cleanupFailedAcpSpawn({
      cfg,
      deleteTranscript: true,
      runtimeCloseHandle: initializedRuntime,
      sessionKey,
      shouldDeleteSession: sessionCreated,
    });
    return createAcpSpawnFailure({
      error: isSessionBindingError(error) ? error.message : summarizeError(error),
      errorCode: isSessionBindingError(error) ? "thread_binding_invalid" : "spawn_failed",
      status: "error",
    });
  }

  const deliveryPlan = resolveAcpSpawnBootstrapDeliveryPlan({
    binding,
    cfg,
    effectiveStreamToParent,
    requestThreadBinding,
    requester: requesterState,
    spawnMode,
  });
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  const streamLogPath =
    effectiveStreamToParent && parentSessionKey
      ? resolveAcpSpawnStreamLogPath({
          childSessionKey: sessionKey,
        })
      : undefined;
  // Resolve parent session delivery context so system events route to the
  // Correct thread/topic instead of falling back to the main DM.
  const parentDeliveryCtx =
    effectiveStreamToParent && parentSessionKey
      ? deliveryContextFromSession(
          loadSessionStore(
            resolveStorePath(cfg.session?.store, {
              agentId: resolveAgentIdFromSessionKey(parentSessionKey),
            }),
          )[parentSessionKey],
        )
      : undefined;

  let parentRelay: AcpSpawnParentRelayHandle | undefined;
  if (effectiveStreamToParent && parentSessionKey) {
    // Register relay before dispatch so fast lifecycle failures are not missed.
    parentRelay = startAcpSpawnParentStreamRelay({
      agentId: targetAgentId,
      childSessionKey: sessionKey,
      deliveryContext: parentDeliveryCtx,
      emitStartNotice: false,
      logPath: streamLogPath,
      parentSessionKey,
      runId: childIdem,
    });
  }
  try {
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        accountId: deliveryPlan.accountId,
        channel: deliveryPlan.channel,
        deliver: deliveryPlan.useInlineDelivery,
        idempotencyKey: childIdem,
        label: params.label || undefined,
        message: params.task,
        sessionKey,
        threadId: deliveryPlan.threadId,
        to: deliveryPlan.to,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = normalizeOptionalString(response?.runId);
    if (responseRunId) {
      childRunId = responseRunId;
    }
  } catch (error) {
    parentRelay?.dispose();
    await cleanupFailedAcpSpawn({
      cfg,
      deleteTranscript: true,
      sessionKey,
      shouldDeleteSession: true,
    });
    return createAcpSpawnFailure({
      childSessionKey: sessionKey,
      error: summarizeError(error),
      errorCode: "dispatch_failed",
      status: "error",
    });
  }

  if (effectiveStreamToParent && parentSessionKey) {
    if (parentRelay && childRunId !== childIdem) {
      parentRelay.dispose();
      // Defensive fallback if gateway returns a runId that differs from idempotency key.
      parentRelay = startAcpSpawnParentStreamRelay({
        agentId: targetAgentId,
        childSessionKey: sessionKey,
        deliveryContext: parentDeliveryCtx,
        emitStartNotice: false,
        logPath: streamLogPath,
        parentSessionKey,
        runId: childRunId,
      });
    }
    parentRelay?.notifyStarted();
    try {
      createRunningTaskRun({
        childSessionKey: sessionKey,
        deliveryStatus: requesterInternalKey ? "pending" : "parent_missing",
        label: params.label,
        ownerKey: requesterInternalKey,
        preferMetadata: true,
        requesterOrigin: requesterState.origin,
        runId: childRunId,
        runtime: "acp",
        scopeKind: "session",
        sourceId: childRunId,
        startedAt: Date.now(),
        task: params.task,
      });
    } catch (error) {
      log.warn("Failed to create background task for ACP spawn", {
        error,
        runId: childRunId,
        sessionKey,
      });
    }
    return {
      status: "accepted",
      childSessionKey: sessionKey,
      runId: childRunId,
      mode: spawnMode,
      ...(streamLogPath ? { streamLogPath } : {}),
      note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
    };
  }

  try {
    createRunningTaskRun({
      childSessionKey: sessionKey,
      deliveryStatus: requesterInternalKey ? "pending" : "parent_missing",
      label: params.label,
      ownerKey: requesterInternalKey,
      preferMetadata: true,
      requesterOrigin: requesterState.origin,
      runId: childRunId,
      runtime: "acp",
      scopeKind: "session",
      sourceId: childRunId,
      startedAt: Date.now(),
      task: params.task,
    });
  } catch (error) {
    log.warn("Failed to create background task for ACP spawn", {
      error,
      runId: childRunId,
      sessionKey,
    });
  }

  return {
    childSessionKey: sessionKey,
    mode: spawnMode,
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
    runId: childRunId,
    status: "accepted",
  };
}
