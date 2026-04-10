import fs from "node:fs/promises";
import path from "node:path";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  type HeartbeatTask,
  isHeartbeatContentEffectivelyEmpty,
  isTaskDue,
  parseHeartbeatTasks,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelHeartbeatDeps } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  archiveRemovedSessionTranscripts,
  saveSessionStore,
  updateSessionStore,
} from "../config/sessions/store.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { resolveCronSession } from "../cron/isolated-agent/session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { escapeRegExp } from "../utils.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { resolveHeartbeatReasonKind } from "./heartbeat-reason.js";
import {
  type HeartbeatSummary,
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatSummaryForAgent,
} from "./heartbeat-summary.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";
import {
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  areHeartbeatsEnabled,
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
  setHeartbeatsEnabled,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatSenderContext,
} from "./outbound/targets.js";
import { peekSystemEventEntries, resolveSystemEventDeliveryContext } from "./system-events.js";

export type HeartbeatDeps = OutboundSendDeps &
  ChannelHeartbeatDeps & {
    getReplyFromConfig?: typeof import("./heartbeat-runner.runtime.js").getReplyFromConfig;
    runtime?: RuntimeEnv;
    getQueueSize?: (lane?: string) => number;
    nowMs?: () => number;
  };

const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatRunnerRuntimePromise: Promise<typeof import("./heartbeat-runner.runtime.js")> | null =
  null;

function loadHeartbeatRunnerRuntime() {
  heartbeatRunnerRuntimePromise ??= import("./heartbeat-runner.runtime.js");
  return heartbeatRunnerRuntimePromise;
}

export { areHeartbeatsEnabled, setHeartbeatsEnabled };
export {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatSummaryForAgent,
  type HeartbeatSummary,
} from "./heartbeat-summary.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
interface HeartbeatAgent {
  agentId: string;
  heartbeat?: HeartbeatConfig;
}

export { isCronSystemEvent };

interface HeartbeatAgentState {
  agentId: string;
  heartbeat?: HeartbeatConfig;
  intervalMs: number;
  lastRunMs?: number;
  nextDueMs: number;
}

export interface HeartbeatRunner {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
}

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  const list = cfg.agents?.list ?? [];
  return list.some((entry) => Boolean(entry?.heartbeat));
}

function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const list = cfg.agents?.list ?? [];
  if (hasExplicitHeartbeatAgents(cfg)) {
    return list
      .filter((entry) => entry?.heartbeat)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        return { agentId: id, heartbeat: resolveHeartbeatConfig(cfg, id) };
      })
      .filter((entry) => entry.agentId);
  }
  const fallbackId = resolveDefaultAgentId(cfg);
  return [{ agentId: fallbackId, heartbeat: resolveHeartbeatConfig(cfg, fallbackId) }];
}

export function resolveHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt);
}

function resolveHeartbeatAckMaxChars(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return Math.max(
    0,
    heartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

function resolveHeartbeatSession(
  cfg: OpenClawConfig,
  agentId?: string,
  heartbeat?: HeartbeatConfig,
  forcedSessionKey?: string,
) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const mainSessionKey =
    scope === "global" ? "global" : resolveAgentMainSessionKey({ agentId: resolvedAgentId, cfg });
  const storeAgentId = scope === "global" ? resolveDefaultAgentId(cfg) : resolvedAgentId;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: storeAgentId,
  });
  const store = loadSessionStore(storePath);
  const mainEntry = store[mainSessionKey];

  if (scope === "global") {
    return {
      entry: mainEntry,
      sessionKey: mainSessionKey,
      store,
      storePath,
      suppressOriginatingContext: false,
    };
  }

  // Guard: never route heartbeats to subagent sessions, regardless of entry path.
  const forced = forcedSessionKey?.trim();
  if (forced && isSubagentSessionKey(forced)) {
    return {
      entry: mainEntry,
      sessionKey: mainSessionKey,
      store,
      storePath,
      suppressOriginatingContext: true,
    };
  }

  if (forced && !isSubagentSessionKey(forced)) {
    const forcedCandidate = toAgentStoreSessionKey({
      agentId: resolvedAgentId,
      mainKey: cfg.session?.mainKey,
      requestKey: forced,
    });
    if (!isSubagentSessionKey(forcedCandidate)) {
      const forcedCanonical = canonicalizeMainSessionAlias({
        agentId: resolvedAgentId,
        cfg,
        sessionKey: forcedCandidate,
      });
      if (forcedCanonical !== "global" && !isSubagentSessionKey(forcedCanonical)) {
        const sessionAgentId = resolveAgentIdFromSessionKey(forcedCanonical);
        if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
          return {
            entry: store[forcedCanonical],
            sessionKey: forcedCanonical,
            store,
            storePath,
            suppressOriginatingContext: false,
          };
        }
      }
    }
  }

  const trimmed = heartbeat?.session?.trim() ?? "";
  if (!trimmed || isSubagentSessionKey(trimmed)) {
    return {
      entry: mainEntry,
      sessionKey: mainSessionKey,
      store,
      storePath,
      suppressOriginatingContext: false,
    };
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (normalized === "main" || normalized === "global") {
    return {
      entry: mainEntry,
      sessionKey: mainSessionKey,
      store,
      storePath,
      suppressOriginatingContext: false,
    };
  }

  const candidate = toAgentStoreSessionKey({
    agentId: resolvedAgentId,
    mainKey: cfg.session?.mainKey,
    requestKey: trimmed,
  });
  if (isSubagentSessionKey(candidate)) {
    return {
      entry: mainEntry,
      sessionKey: mainSessionKey,
      store,
      storePath,
      suppressOriginatingContext: false,
    };
  }
  const canonical = canonicalizeMainSessionAlias({
    agentId: resolvedAgentId,
    cfg,
    sessionKey: candidate,
  });
  if (canonical !== "global" && !isSubagentSessionKey(canonical)) {
    const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
    if (sessionAgentId === normalizeAgentId(resolvedAgentId)) {
      return {
        entry: store[canonical],
        sessionKey: canonical,
        store,
        storePath,
        suppressOriginatingContext: false,
      };
    }
  }

  return {
    entry: mainEntry,
    sessionKey: mainSessionKey,
    store,
    storePath,
    suppressOriginatingContext: false,
  };
}

function resolveIsolatedHeartbeatSessionKey(params: {
  sessionKey: string;
  configuredSessionKey: string;
  sessionEntry?: { heartbeatIsolatedBaseSessionKey?: string };
}) {
  const storedBaseSessionKey = params.sessionEntry?.heartbeatIsolatedBaseSessionKey?.trim();
  if (storedBaseSessionKey) {
    const suffix = params.sessionKey.slice(storedBaseSessionKey.length);
    if (
      params.sessionKey.startsWith(storedBaseSessionKey) &&
      suffix.length > 0 &&
      /^(:heartbeat)+$/.test(suffix)
    ) {
      return {
        isolatedBaseSessionKey: storedBaseSessionKey,
        isolatedSessionKey: `${storedBaseSessionKey}:heartbeat`,
      };
    }
  }

  // Collapse repeated `:heartbeat` suffixes introduced by wake-triggered re-entry.
  // The guard on configuredSessionKey ensures we do not strip a legitimate single
  // `:heartbeat` suffix that is part of the user-configured base key itself
  // (e.g. heartbeat.session: "alerts:heartbeat"). When the configured key already
  // Ends with `:heartbeat`, a forced wake passes `configuredKey:heartbeat` which
  // Must be treated as a new base rather than an existing isolated key.
  const configuredSuffix = params.sessionKey.slice(params.configuredSessionKey.length);
  if (
    params.sessionKey.startsWith(params.configuredSessionKey) &&
    /^(:heartbeat)+$/.test(configuredSuffix) &&
    !params.configuredSessionKey.endsWith(":heartbeat")
  ) {
    return {
      isolatedBaseSessionKey: params.configuredSessionKey,
      isolatedSessionKey: `${params.configuredSessionKey}:heartbeat`,
    };
  }
  return {
    isolatedBaseSessionKey: params.sessionKey,
    isolatedSessionKey: `${params.sessionKey}:heartbeat`,
  };
}

function resolveStaleHeartbeatIsolatedSessionKey(params: {
  sessionKey: string;
  isolatedSessionKey: string;
  isolatedBaseSessionKey: string;
}) {
  if (params.sessionKey === params.isolatedSessionKey) {
    return undefined;
  }
  const suffix = params.sessionKey.slice(params.isolatedBaseSessionKey.length);
  if (
    params.sessionKey.startsWith(params.isolatedBaseSessionKey) &&
    suffix.length > 0 &&
    /^(:heartbeat)+$/.test(suffix)
  ) {
    return params.sessionKey;
  }
  return undefined;
}

function resolveHeartbeatReasoningPayloads(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload[] {
  const payloads = Array.isArray(replyResult) ? replyResult : (replyResult ? [replyResult] : []);
  return payloads.filter((payload) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text.trimStart().startsWith("Reasoning:");
  });
}

async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") {
    return;
  }
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextUpdatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
  if (entry.updatedAt === nextUpdatedAt) {
    return;
  }
  await updateSessionStore(storePath, (nextStore) => {
    const nextEntry = nextStore[sessionKey] ?? entry;
    if (!nextEntry) {
      return;
    }
    const resolvedUpdatedAt = Math.max(nextEntry.updatedAt ?? 0, updatedAt);
    if (nextEntry.updatedAt === resolvedUpdatedAt) {
      return;
    }
    nextStore[sessionKey] = { ...nextEntry, updatedAt: resolvedUpdatedAt };
  });
}

function stripLeadingHeartbeatResponsePrefix(
  text: string,
  responsePrefix: string | undefined,
): string {
  const normalizedPrefix = responsePrefix?.trim();
  if (!normalizedPrefix) {
    return text;
  }

  // Require a boundary after the configured prefix so short prefixes like "Hi"
  // Do not strip the beginning of normal words like "History".
  const prefixPattern = new RegExp(
    `^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`,
    "iu",
  );
  return text.replace(prefixPattern, "");
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
) {
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const textForStrip = stripLeadingHeartbeatResponsePrefix(rawText, responsePrefix);
  const stripped = stripHeartbeatToken(textForStrip, {
    maxAckChars: ackMaxChars,
    mode: "heartbeat",
  });
  const {hasMedia} = resolveSendableOutboundReplyParts(payload);
  if (stripped.shouldSkip && !hasMedia) {
    return {
      hasMedia,
      shouldSkip: true,
      text: "",
    };
  }
  let finalText = stripped.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { hasMedia, shouldSkip: false, text: finalText };
}

interface HeartbeatReasonFlags {
  isExecEventReason: boolean;
  isCronEventReason: boolean;
  isWakeReason: boolean;
}

type HeartbeatSkipReason = "empty-heartbeat-file";

type HeartbeatPreflight = HeartbeatReasonFlags & {
  session: ReturnType<typeof resolveHeartbeatSession>;
  pendingEventEntries: ReturnType<typeof peekSystemEventEntries>;
  turnSourceDeliveryContext: ReturnType<typeof resolveSystemEventDeliveryContext>;
  hasTaggedCronEvents: boolean;
  shouldInspectPendingEvents: boolean;
  skipReason?: HeartbeatSkipReason;
  tasks?: HeartbeatTask[];
  heartbeatFileContent?: string;
};

function resolveHeartbeatReasonFlags(reason?: string): HeartbeatReasonFlags {
  const reasonKind = resolveHeartbeatReasonKind(reason);
  return {
    isCronEventReason: reasonKind === "cron",
    isExecEventReason: reasonKind === "exec-event",
    isWakeReason: reasonKind === "wake" || reasonKind === "hook",
  };
}

async function resolveHeartbeatPreflight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  forcedSessionKey?: string;
  reason?: string;
}): Promise<HeartbeatPreflight> {
  const reasonFlags = resolveHeartbeatReasonFlags(params.reason);
  const session = resolveHeartbeatSession(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.forcedSessionKey,
  );
  const pendingEventEntries = peekSystemEventEntries(session.sessionKey);
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  const shouldInspectPendingEvents =
    reasonFlags.isExecEventReason || reasonFlags.isCronEventReason || hasTaggedCronEvents;
  const shouldBypassFileGates =
    reasonFlags.isExecEventReason ||
    reasonFlags.isCronEventReason ||
    reasonFlags.isWakeReason ||
    hasTaggedCronEvents;
  const basePreflight = {
    ...reasonFlags,
    hasTaggedCronEvents,
    pendingEventEntries,
    session,
    shouldInspectPendingEvents,
    turnSourceDeliveryContext,
  } satisfies Omit<HeartbeatPreflight, "skipReason">;

  if (shouldBypassFileGates) {
    return basePreflight;
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let heartbeatFileContent: string | undefined;
  try {
    heartbeatFileContent = await fs.readFile(heartbeatFilePath, "utf8");
    const tasks = parseHeartbeatTasks(heartbeatFileContent);
    if (isHeartbeatContentEffectivelyEmpty(heartbeatFileContent) && tasks.length === 0) {
      return {
        ...basePreflight,
        heartbeatFileContent,
        skipReason: "empty-heartbeat-file",
        tasks: [],
      };
    }
    // Return tasks even if file has other content - backward compatible
    return {
      ...basePreflight,
      heartbeatFileContent,
      tasks,
    };
  } catch (error: unknown) {
    if (hasErrnoCode(error, "ENOENT")) {
      // Missing HEARTBEAT.md is intentional in some setups (for example, when
      // Heartbeat instructions live outside the file), so keep the run active.
      // The heartbeat prompt already says "if it exists".
      return basePreflight;
    }
    // For other read errors, proceed with heartbeat as before.
  }

  return basePreflight;
}

interface HeartbeatPromptResolution {
  prompt: string | null;
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
}

function appendHeartbeatWorkspacePathHint(prompt: string, workspaceDir: string): string {
  if (!/heartbeat\.md/i.test(prompt)) {
    return prompt;
  }
  const heartbeatFilePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME).replace(/\\/g, "/");
  const hint = `When reading HEARTBEAT.md, use workspace file ${heartbeatFilePath} (exact case). Do not read docs/heartbeat.md.`;
  if (prompt.includes(hint)) {
    return prompt;
  }
  return `${prompt}\n${hint}`;
}

function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  workspaceDir: string;
  startedAt: number;
  heartbeatFileContent?: string;
}): HeartbeatPromptResolution {
  const {pendingEventEntries} = params.preflight;
  const pendingEvents = params.preflight.shouldInspectPendingEvents
    ? pendingEventEntries.map((event) => event.text)
    : [];
  const cronEvents = pendingEventEntries
    .filter(
      (event) =>
        (params.preflight.isCronEventReason || event.contextKey?.startsWith("cron:")) &&
        isCronSystemEvent(event.text),
    )
    .map((event) => event.text);
  const hasExecCompletion = pendingEvents.some(isExecCompletionEvent);
  const hasCronEvents = cronEvents.length > 0;

  // If tasks are defined, build a batched prompt with due tasks
  if (params.preflight.tasks && params.preflight.tasks.length > 0) {
    const {tasks} = params.preflight;
    const dueTasks = tasks.filter((task) =>
      isTaskDue(
        (params.preflight.session.entry?.heartbeatTaskState as Record<string, number>)?.[task.name],
        task.interval,
        params.startedAt,
      ),
    );

    if (dueTasks.length > 0) {
      const taskList = dueTasks.map((task) => `- ${task.name}: ${task.prompt}`).join("\n");
      let prompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

After completing all due tasks, reply HEARTBEAT_OK.`;

      // Preserve HEARTBEAT.md directives (non-task content)
      if (params.heartbeatFileContent) {
        const directives = params.heartbeatFileContent
          .replace(/^[\s\S]*?^tasks:[\s\S]*?(?=^[^\s]|^$)/m, "")
          .trim();
        if (directives) {
          prompt += `\n\nAdditional context from HEARTBEAT.md:\n${directives}`;
        }
      }
      return { hasCronEvents: false, hasExecCompletion: false, prompt };
    }
    // No tasks due - skip this heartbeat to avoid wasteful API calls
    return { hasCronEvents: false, hasExecCompletion: false, prompt: null };
  }

  // Fallback to original behavior
  const basePrompt = hasExecCompletion
    ? buildExecEventPrompt({ deliverToUser: params.canRelayToUser })
    : (hasCronEvents
      ? buildCronEventPrompt(cronEvents, { deliverToUser: params.canRelayToUser })
      : resolveHeartbeatPrompt(params.cfg, params.heartbeat));
  const prompt = appendHeartbeatWorkspacePathHint(basePrompt, params.workspaceDir);

  return { hasCronEvents, hasExecCompletion, prompt };
}

export async function runHeartbeatOnce(opts: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatConfig;
  reason?: string;
  deps?: HeartbeatDeps;
}): Promise<HeartbeatRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  const explicitAgentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
  const forcedSessionAgentId =
    explicitAgentId.length > 0 ? undefined : parseAgentSessionKey(opts.sessionKey)?.agentId;
  const agentId = normalizeAgentId(
    explicitAgentId || forcedSessionAgentId || resolveDefaultAgentId(cfg),
  );
  const heartbeat = opts.heartbeat ?? resolveHeartbeatConfig(cfg, agentId);
  if (!areHeartbeatsEnabled()) {
    return { reason: "disabled", status: "skipped" };
  }
  if (!isHeartbeatEnabledForAgent(cfg, agentId)) {
    return { reason: "disabled", status: "skipped" };
  }
  if (!resolveHeartbeatIntervalMs(cfg, undefined, heartbeat)) {
    return { reason: "disabled", status: "skipped" };
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  if (!isWithinActiveHours(cfg, heartbeat, startedAt)) {
    return { reason: "quiet-hours", status: "skipped" };
  }

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)(CommandLane.Main);
  if (queueSize > 0) {
    return { reason: "requests-in-flight", status: "skipped" };
  }

  // Preflight centralizes trigger classification, event inspection, and HEARTBEAT.md gating.
  const preflight = await resolveHeartbeatPreflight({
    agentId,
    cfg,
    forcedSessionKey: opts.sessionKey,
    heartbeat,
    reason: opts.reason,
  });
  if (preflight.skipReason) {
    emitHeartbeatEvent({
      durationMs: Date.now() - startedAt,
      reason: preflight.skipReason,
      status: "skipped",
    });
    return { reason: preflight.skipReason, status: "skipped" };
  }
  const { entry, sessionKey, storePath, suppressOriginatingContext } = preflight.session;

  // Check the resolved session lane — if it is busy, skip to avoid interrupting
  // An active streaming turn.  The wake-layer retry (heartbeat-wake.ts) will
  // Re-schedule this wake automatically.  See #14396 (closed without merge).
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey);
  const sessionLaneSize = (opts.deps?.getQueueSize ?? getQueueSize)(sessionLaneKey);
  if (sessionLaneSize > 0) {
    emitHeartbeatEvent({
      durationMs: Date.now() - startedAt,
      reason: "requests-in-flight",
      status: "skipped",
    });
    return { reason: "requests-in-flight", status: "skipped" };
  }

  const previousUpdatedAt = entry?.updatedAt;

  // When isolatedSession is enabled, create a fresh session via the same
  // Pattern as cron sessionTarget: "isolated". This gives the heartbeat
  // A new session ID (empty transcript) each run, avoiding the cost of
  // Sending the full conversation history (~100K tokens) to the LLM.
  // Delivery routing still uses the main session entry (lastChannel, lastTo).
  const useIsolatedSession = heartbeat?.isolatedSession === true;
  const delivery = resolveHeartbeatDeliveryTarget({
    cfg,
    entry,
    heartbeat,
    // Isolated heartbeat runs drain system events from their dedicated
    // `:heartbeat` session, not from the base session we peek during preflight.
    // Reusing base-session turnSource routing here can pin later isolated runs
    // To stale channels/threads because that base-session event context remains queued.
    turnSource: useIsolatedSession ? undefined : preflight.turnSourceDeliveryContext,
  });
  const heartbeatAccountId = heartbeat?.accountId?.trim();
  if (delivery.reason === "unknown-account") {
    log.warn("heartbeat: unknown accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId ?? null,
      target: heartbeat?.target ?? "none",
    });
  } else if (heartbeatAccountId) {
    log.info("heartbeat: using explicit accountId", {
      accountId: delivery.accountId ?? heartbeatAccountId,
      channel: delivery.channel,
      target: heartbeat?.target ?? "none",
    });
  }
  const visibility =
    delivery.channel !== "none"
      ? resolveHeartbeatVisibility({
          accountId: delivery.accountId,
          cfg,
          channel: delivery.channel,
        })
      : { showAlerts: true, showOk: false, useIndicator: true };
  const { sender } = resolveHeartbeatSenderContext({ cfg, delivery, entry });
  const {responsePrefix} = resolveEffectiveMessagesConfig(cfg, agentId, {
    accountId: delivery.accountId,
    channel: delivery.channel !== "none" ? delivery.channel : undefined,
  });

  const canRelayToUser = Boolean(
    delivery.channel !== "none" && delivery.to && visibility.showAlerts,
  );
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({
    canRelayToUser,
    cfg,
    heartbeat,
    heartbeatFileContent: preflight.heartbeatFileContent,
    preflight,
    startedAt,
    workspaceDir,
  });

  // If no tasks are due, skip heartbeat entirely
  if (prompt === null) {
    return { reason: "no-tasks-due", status: "skipped" };
  }

  let runSessionKey = sessionKey;
  if (useIsolatedSession) {
    const configuredSession = resolveHeartbeatSession(cfg, agentId, heartbeat);
    // Collapse only the repeated `:heartbeat` suffixes introduced by wake-triggered
    // Re-entry for heartbeat-created isolated sessions. Real session keys that
    // Happen to end with `:heartbeat` still get a distinct isolated sibling.
    const { isolatedSessionKey, isolatedBaseSessionKey } = resolveIsolatedHeartbeatSessionKey({
      configuredSessionKey: configuredSession.sessionKey,
      sessionEntry: entry,
      sessionKey,
    });
    const cronSession = resolveCronSession({
      agentId,
      cfg,
      forceNew: true,
      nowMs: startedAt,
      sessionKey: isolatedSessionKey,
    });
    const staleIsolatedSessionKey = resolveStaleHeartbeatIsolatedSessionKey({
      isolatedBaseSessionKey,
      isolatedSessionKey,
      sessionKey,
    });
    const removedSessionFiles = new Map<string, string | undefined>();
    if (staleIsolatedSessionKey) {
      const staleEntry = cronSession.store[staleIsolatedSessionKey];
      if (staleEntry?.sessionId) {
        removedSessionFiles.set(staleEntry.sessionId, staleEntry.sessionFile);
      }
      delete cronSession.store[staleIsolatedSessionKey];
    }
    cronSession.sessionEntry.heartbeatIsolatedBaseSessionKey = isolatedBaseSessionKey;
    cronSession.store[isolatedSessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
    if (removedSessionFiles.size > 0) {
      try {
        const referencedSessionIds = new Set(
          Object.values(cronSession.store)
            .map((sessionEntry) => sessionEntry?.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        await archiveRemovedSessionTranscripts({
          reason: "deleted",
          referencedSessionIds,
          removedSessionFiles,
          restrictToStoreDir: true,
          storePath: cronSession.storePath,
        });
      } catch (error) {
        log.warn("heartbeat: failed to archive stale isolated session transcript", {
          err: String(error),
          sessionKey: staleIsolatedSessionKey,
        });
      }
    }
    runSessionKey = isolatedSessionKey;
  }

  // Update task last run times AFTER successful heartbeat completion
  const updateTaskTimestamps = async () => {
    if (!preflight.tasks || preflight.tasks.length === 0) {
      return;
    }

    const store = loadSessionStore(storePath);
    const current = store[sessionKey];
    // Initialize stub entry on first run when current doesn't exist
    const base = current ?? {
      // Generate valid sessionId - derive from sessionKey without colons
      createdAt: startedAt,
      heartbeatTaskState: {},
      lastMessageAt: startedAt,
      messageCount: 0,
      sessionId: sessionKey.replace(/:/g, "_"),
      updatedAt: startedAt,
    };
    const taskState = { ...base.heartbeatTaskState };

    for (const task of preflight.tasks) {
      if (isTaskDue(taskState[task.name], task.interval, startedAt)) {
        taskState[task.name] = startedAt;
      }
    }

    store[sessionKey] = { ...base, heartbeatTaskState: taskState };
    await saveSessionStore(storePath, store);
  };

  const ctx = {
    AccountId: delivery.accountId,
    Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
    ForceSenderIsOwnerFalse: hasExecCompletion,
    From: sender,
    MessageThreadId: delivery.threadId,
    OriginatingChannel:
      !suppressOriginatingContext && delivery.channel !== "none" ? delivery.channel : undefined,
    OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
    Provider: hasExecCompletion ? "exec-event" : (hasCronEvents ? "cron-event" : "heartbeat"),
    SessionKey: runSessionKey,
    To: sender,
  };
  if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
    emitHeartbeatEvent({
      accountId: delivery.accountId,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      durationMs: Date.now() - startedAt,
      reason: "alerts-disabled",
      status: "skipped",
    });
    return { reason: "alerts-disabled", status: "skipped" };
  }

  const heartbeatOkText = responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
  const outboundSession = buildOutboundSessionContext({
    agentId,
    cfg,
    sessionKey,
  });
  const canAttemptHeartbeatOk = Boolean(
    visibility.showOk && delivery.channel !== "none" && delivery.to,
  );
  const maybeSendHeartbeatOk = async () => {
    if (!canAttemptHeartbeatOk || delivery.channel === "none" || !delivery.to) {
      return false;
    }
    const heartbeatPlugin = getChannelPlugin(delivery.channel);
    if (heartbeatPlugin?.heartbeat?.checkReady) {
      const readiness = await heartbeatPlugin.heartbeat.checkReady({
        accountId: delivery.accountId,
        cfg,
        deps: opts.deps,
      });
      if (!readiness.ok) {
        return false;
      }
    }
    await deliverOutboundPayloads({
      accountId: delivery.accountId,
      cfg,
      channel: delivery.channel,
      deps: opts.deps,
      payloads: [{ text: heartbeatOkText }],
      session: outboundSession,
      threadId: delivery.threadId,
      to: delivery.to,
    });
    return true;
  };

  try {
    const heartbeatModelOverride = normalizeOptionalString(heartbeat?.model);
    const suppressToolErrorWarnings = heartbeat?.suppressToolErrorWarnings === true;
    const bootstrapContextMode: "lightweight" | undefined =
      heartbeat?.lightContext === true ? "lightweight" : undefined;
    const replyOpts = heartbeatModelOverride
      ? {
          bootstrapContextMode,
          heartbeatModelOverride,
          isHeartbeat: true,
          suppressToolErrorWarnings,
        }
      : { bootstrapContextMode, isHeartbeat: true, suppressToolErrorWarnings };
    const getReplyFromConfig =
      opts.deps?.getReplyFromConfig ?? (await loadHeartbeatRunnerRuntime()).getReplyFromConfig;
    const replyResult = await getReplyFromConfig(ctx, replyOpts, cfg);
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);
    const includeReasoning = heartbeat?.includeReasoning === true;
    const reasoningPayloads = includeReasoning
      ? resolveHeartbeatReasoningPayloads(replyResult).filter((payload) => payload !== replyPayload)
      : [];

    if (!replyPayload || !hasOutboundReplyContent(replyPayload)) {
      await restoreHeartbeatUpdatedAt({
        sessionKey,
        storePath,
        updatedAt: previousUpdatedAt,
      });

      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        accountId: delivery.accountId,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        durationMs: Date.now() - startedAt,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : undefined,
        reason: opts.reason,
        silent: !okSent,
        status: "ok-empty",
      });
      await updateTaskTimestamps();
      return { durationMs: Date.now() - startedAt, status: "ran" };
    }

    const ackMaxChars = resolveHeartbeatAckMaxChars(cfg, heartbeat);
    const normalized = normalizeHeartbeatReply(replyPayload, responsePrefix, ackMaxChars);
    // For exec completion events, don't skip even if the response looks like HEARTBEAT_OK.
    // The model should be responding with exec results, not ack tokens.
    // Also, if normalized.text is empty due to token stripping but we have exec completion,
    // Fall back to the original reply text.
    const execFallbackText =
      hasExecCompletion && !normalized.text.trim() && replyPayload.text?.trim()
        ? replyPayload.text.trim()
        : null;
    if (execFallbackText) {
      normalized.text = execFallbackText;
      normalized.shouldSkip = false;
    }
    const shouldSkipMain = normalized.shouldSkip && !normalized.hasMedia && !hasExecCompletion;
    if (shouldSkipMain && reasoningPayloads.length === 0) {
      await restoreHeartbeatUpdatedAt({
        sessionKey,
        storePath,
        updatedAt: previousUpdatedAt,
      });

      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        accountId: delivery.accountId,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        durationMs: Date.now() - startedAt,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : undefined,
        reason: opts.reason,
        silent: !okSent,
        status: "ok-token",
      });
      await updateTaskTimestamps();
      return { durationMs: Date.now() - startedAt, status: "ran" };
    }

    const {mediaUrls} = resolveSendableOutboundReplyParts(replyPayload);

    // Suppress duplicate heartbeats (same payload) within a short window.
    // This prevents "nagging" when nothing changed but the model repeats the same items.
    const prevHeartbeatText =
      typeof entry?.lastHeartbeatText === "string" ? entry.lastHeartbeatText : "";
    const prevHeartbeatAt =
      typeof entry?.lastHeartbeatSentAt === "number" ? entry.lastHeartbeatSentAt : undefined;
    const isDuplicateMain =
      !shouldSkipMain &&
      !mediaUrls.length &&
      Boolean(prevHeartbeatText.trim()) &&
      normalized.text.trim() === prevHeartbeatText.trim() &&
      typeof prevHeartbeatAt === "number" &&
      startedAt - prevHeartbeatAt < 24 * 60 * 60 * 1000;

    if (isDuplicateMain) {
      await restoreHeartbeatUpdatedAt({
        sessionKey,
        storePath,
        updatedAt: previousUpdatedAt,
      });

      emitHeartbeatEvent({
        accountId: delivery.accountId,
        channel: delivery.channel !== "none" ? delivery.channel : undefined,
        durationMs: Date.now() - startedAt,
        hasMedia: false,
        preview: normalized.text.slice(0, 200),
        reason: "duplicate",
        status: "skipped",
      });
      await updateTaskTimestamps();
      return { durationMs: Date.now() - startedAt, status: "ran" };
    }

    // Reasoning payloads are text-only; any attachments stay on the main reply.
    const previewText = shouldSkipMain
      ? reasoningPayloads
          .map((payload) => payload.text)
          .filter((text): text is string => Boolean(text?.trim()))
          .join("\n")
      : normalized.text;

    if (delivery.channel === "none" || !delivery.to) {
      emitHeartbeatEvent({
        accountId: delivery.accountId,
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
        preview: previewText?.slice(0, 200),
        reason: delivery.reason ?? "no-target",
        status: "skipped",
      });
      await updateTaskTimestamps();
      return { durationMs: Date.now() - startedAt, status: "ran" };
    }

    if (!visibility.showAlerts) {
      await updateTaskTimestamps();
      await restoreHeartbeatUpdatedAt({
        sessionKey,
        storePath,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        accountId: delivery.accountId,
        channel: delivery.channel,
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
        preview: previewText?.slice(0, 200),
        reason: "alerts-disabled",
        status: "skipped",
      });
      return { durationMs: Date.now() - startedAt, status: "ran" };
    }

    const deliveryAccountId = delivery.accountId;
    const heartbeatPlugin = getChannelPlugin(delivery.channel);
    if (heartbeatPlugin?.heartbeat?.checkReady) {
      const readiness = await heartbeatPlugin.heartbeat.checkReady({
        accountId: deliveryAccountId,
        cfg,
        deps: opts.deps,
      });
      if (!readiness.ok) {
        emitHeartbeatEvent({
          accountId: delivery.accountId,
          channel: delivery.channel,
          durationMs: Date.now() - startedAt,
          hasMedia: mediaUrls.length > 0,
          preview: previewText?.slice(0, 200),
          reason: readiness.reason,
          status: "skipped",
        });
        log.info("heartbeat: channel not ready", {
          channel: delivery.channel,
          reason: readiness.reason,
        });
        return { reason: readiness.reason, status: "skipped" };
      }
    }

    await deliverOutboundPayloads({
      accountId: deliveryAccountId,
      cfg,
      channel: delivery.channel,
      deps: opts.deps,
      payloads: [
        ...reasoningPayloads,
        ...(shouldSkipMain
          ? []
          : [
              {
                mediaUrls,
                text: normalized.text,
              },
            ]),
      ],
      session: outboundSession,
      threadId: delivery.threadId,
      to: delivery.to,
    });

    // Record last delivered heartbeat payload for dedupe.
    if (!shouldSkipMain && normalized.text.trim()) {
      const store = loadSessionStore(storePath);
      const current = store[sessionKey];
      if (current) {
        store[sessionKey] = {
          ...current,
          lastHeartbeatSentAt: startedAt,
          lastHeartbeatText: normalized.text,
        };
        await saveSessionStore(storePath, store);
      }
    }

    emitHeartbeatEvent({
      accountId: delivery.accountId,
      channel: delivery.channel,
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
      preview: previewText?.slice(0, 200),
      status: "sent",
      to: delivery.to,
    });
    await updateTaskTimestamps();
    return { durationMs: Date.now() - startedAt, status: "ran" };
  } catch (error) {
    const reason = formatErrorMessage(error);
    emitHeartbeatEvent({
      accountId: delivery.accountId,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      durationMs: Date.now() - startedAt,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
      reason,
      status: "failed",
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { reason, status: "failed" };
  }
}

export function startHeartbeatRunner(opts: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  runOnce?: typeof runHeartbeatOnce;
}): HeartbeatRunner {
  const runtime = opts.runtime ?? defaultRuntime;
  const runOnce = opts.runOnce ?? runHeartbeatOnce;
  const state = {
    agents: new Map<string, HeartbeatAgentState>(),
    cfg: opts.cfg ?? loadConfig(),
    runtime,
    stopped: false,
    timer: null as NodeJS.Timeout | null,
  };
  let initialized = false;

  const resolveNextDue = (now: number, intervalMs: number, prevState?: HeartbeatAgentState) => {
    if (typeof prevState?.lastRunMs === "number") {
      return prevState.lastRunMs + intervalMs;
    }
    if (prevState && prevState.intervalMs === intervalMs && prevState.nextDueMs > now) {
      return prevState.nextDueMs;
    }
    return now + intervalMs;
  };

  const advanceAgentSchedule = (agent: HeartbeatAgentState, now: number) => {
    agent.lastRunMs = now;
    agent.nextDueMs = now + agent.intervalMs;
  };

  const scheduleNext = () => {
    if (state.stopped) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.agents.size === 0) {
      return;
    }
    const now = Date.now();
    let nextDue = Number.POSITIVE_INFINITY;
    for (const agent of state.agents.values()) {
      if (agent.nextDueMs < nextDue) {
        nextDue = agent.nextDueMs;
      }
    }
    if (!Number.isFinite(nextDue)) {
      return;
    }
    const delay = Math.max(0, nextDue - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      requestHeartbeatNow({ coalesceMs: 0, reason: "interval" });
    }, delay);
    state.timer.unref?.();
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    if (state.stopped) {
      return;
    }
    const now = Date.now();
    const prevAgents = state.agents;
    const prevEnabled = prevAgents.size > 0;
    const nextAgents = new Map<string, HeartbeatAgentState>();
    const intervals: number[] = [];
    for (const agent of resolveHeartbeatAgents(cfg)) {
      const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat);
      if (!intervalMs) {
        continue;
      }
      intervals.push(intervalMs);
      const prevState = prevAgents.get(agent.agentId);
      const nextDueMs = resolveNextDue(now, intervalMs, prevState);
      nextAgents.set(agent.agentId, {
        agentId: agent.agentId,
        heartbeat: agent.heartbeat,
        intervalMs,
        lastRunMs: prevState?.lastRunMs,
        nextDueMs,
      });
    }

    state.cfg = cfg;
    state.agents = nextAgents;
    const nextEnabled = nextAgents.size > 0;
    if (!initialized) {
      if (!nextEnabled) {
        log.info("heartbeat: disabled", { enabled: false });
      } else {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      }
      initialized = true;
    } else if (prevEnabled !== nextEnabled) {
      if (!nextEnabled) {
        log.info("heartbeat: disabled", { enabled: false });
      } else {
        log.info("heartbeat: started", { intervalMs: Math.min(...intervals) });
      }
    }

    scheduleNext();
  };

  const run: HeartbeatWakeHandler = async (params) => {
    if (state.stopped) {
      return {
        reason: "disabled",
        status: "skipped",
      } satisfies HeartbeatRunResult;
    }
    if (!areHeartbeatsEnabled()) {
      return {
        reason: "disabled",
        status: "skipped",
      } satisfies HeartbeatRunResult;
    }
    if (state.agents.size === 0) {
      return {
        reason: "disabled",
        status: "skipped",
      } satisfies HeartbeatRunResult;
    }

    const reason = params?.reason;
    const requestedAgentId = params?.agentId ? normalizeAgentId(params.agentId) : undefined;
    const requestedSessionKey = normalizeOptionalString(params?.sessionKey);
    const isInterval = reason === "interval";
    const startedAt = Date.now();
    const now = startedAt;
    let ran = false;
    // Track requests-in-flight so we can skip re-arm in finally — the wake
    // Layer handles retry for this case (DEFAULT_RETRY_MS = 1 s).
    let requestsInFlight = false;

    try {
      if (requestedSessionKey || requestedAgentId) {
        const targetAgentId = requestedAgentId ?? resolveAgentIdFromSessionKey(requestedSessionKey);
        const targetAgent = state.agents.get(targetAgentId);
        if (!targetAgent) {
          return { reason: "disabled", status: "skipped" };
        }
        try {
          const res = await runOnce({
            agentId: targetAgent.agentId,
            cfg: state.cfg,
            deps: { runtime: state.runtime },
            heartbeat: targetAgent.heartbeat,
            reason,
            sessionKey: requestedSessionKey,
          });
          if (res.status !== "skipped" || res.reason !== "disabled") {
            advanceAgentSchedule(targetAgent, now);
          }
          return res.status === "ran" ? { durationMs: Date.now() - startedAt, status: "ran" } : res;
        } catch (error) {
          const errMsg = formatErrorMessage(error);
          log.error(`heartbeat runner: targeted runOnce threw unexpectedly: ${errMsg}`, {
            error: errMsg,
          });
          advanceAgentSchedule(targetAgent, now);
          return { reason: errMsg, status: "failed" };
        }
      }

      for (const agent of state.agents.values()) {
        if (isInterval && now < agent.nextDueMs) {
          continue;
        }

        let res: HeartbeatRunResult;
        try {
          res = await runOnce({
            agentId: agent.agentId,
            cfg: state.cfg,
            deps: { runtime: state.runtime },
            heartbeat: agent.heartbeat,
            reason,
          });
        } catch (error) {
          const errMsg = formatErrorMessage(error);
          log.error(`heartbeat runner: runOnce threw unexpectedly: ${errMsg}`, { error: errMsg });
          advanceAgentSchedule(agent, now);
          continue;
        }
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          // Do not advance the schedule — the main lane is busy and the wake
          // Layer will retry shortly (DEFAULT_RETRY_MS = 1 s).  Calling
          // ScheduleNext() here would register a 0 ms timer that races with
          // The wake layer's 1 s retry and wins, bypassing the cooldown.
          requestsInFlight = true;
          return res;
        }
        if (res.status !== "skipped" || res.reason !== "disabled") {
          advanceAgentSchedule(agent, now);
        }
        if (res.status === "ran") {
          ran = true;
        }
      }

      if (ran) {
        return { durationMs: Date.now() - startedAt, status: "ran" };
      }
      return { reason: isInterval ? "not-due" : "disabled", status: "skipped" };
    } finally {
      // Always re-arm the timer — except for requests-in-flight, where the
      // Wake layer (heartbeat-wake.ts) handles retry via schedule(DEFAULT_RETRY_MS).
      if (!requestsInFlight) {
        scheduleNext();
      }
    }
  };

  const wakeHandler: HeartbeatWakeHandler = async (params) =>
    run({
      agentId: params.agentId,
      reason: params.reason,
      sessionKey: params.sessionKey,
    });
  const disposeWakeHandler = setHeartbeatWakeHandler(wakeHandler);
  updateConfig(state.cfg);

  const cleanup = () => {
    if (state.stopped) {
      return;
    }
    state.stopped = true;
    disposeWakeHandler();
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = null;
  };

  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup, updateConfig };
}
