import crypto from 'node:crypto';
import { clearSessionQueues } from '../auto-reply/reply/queue.js';
import {
  type SubagentTargetResolution,
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
} from '../auto-reply/reply/subagents-utils.js';
import type { OpenClawConfig } from '../config/config.js';
import type { SessionEntry } from '../config/sessions.js';
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
} from '../config/sessions.js';
import { callGateway } from '../gateway/call.js';
import { logVerbose } from '../globals.js';
import { formatErrorMessage } from '../infra/errors.js';
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
} from '../routing/session-key.js';
import { INTERNAL_MESSAGE_CHANNEL } from '../utils/message-channel.js';
import { AGENT_LANE_SUBAGENT } from './lanes.js';
import { abortEmbeddedPiRun } from './pi-embedded-runner/runs.js';
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from './run-wait.js';
import { resolveStoredSubagentCapabilities } from './subagent-capabilities.js';
import {
  type BuiltSubagentList,
  type SessionEntryResolution,
  type SubagentListItem,
  buildLatestSubagentRunIndex,
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
  resolveSessionEntryForKey,
} from './subagent-list.js';
import { subagentRuns } from './subagent-registry-memory.js';
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from './subagent-registry-read.js';
import { getSubagentRunsSnapshotForRead } from './subagent-registry-state.js';
import {
  clearSubagentRunSteerRestart,
  countPendingDescendantRuns,
  markSubagentRunForSteerRestart,
  markSubagentRunTerminated,
  replaceSubagentRunAfterSteer,
} from './subagent-registry.js';
import type { SubagentRunRecord } from './subagent-registry.types.js';
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from './tools/sessions-helpers.js';

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;
export const MAX_STEER_MESSAGE_CHARS = 4000;
export const STEER_RATE_LIMIT_MS = 2000;
export const STEER_ABORT_SETTLE_TIMEOUT_MS = 5000;
const SUBAGENT_REPLY_HISTORY_LIMIT = 50;

const steerRateLimit = new Map<string, number>();

type GatewayCaller = typeof callGateway;

const defaultSubagentControlDeps = {
  callGateway,
};

let subagentControlDeps: {
  callGateway: GatewayCaller;
} = defaultSubagentControlDeps;

export interface ResolvedSubagentController {
  controllerSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: 'children' | 'none';
}
export type { BuiltSubagentList, SessionEntryResolution, SubagentListItem };
export {
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
  resolveSessionEntryForKey,
};

export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    alias,
    key: callerRaw,
    mainKey,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      callerIsSubagent: false,
      callerSessionKey,
      controlScope: 'children',
      controllerSessionKey: callerSessionKey,
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
  });
  return {
    callerIsSubagent: true,
    callerSessionKey,
    controlScope: capabilities.controlScope,
    controllerSessionKey: callerSessionKey,
  };
}

export function listControlledSubagentRuns(
  controllerSessionKey: string,
): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const { latestByChildSessionKey } = buildLatestSubagentRunIndex(snapshot);
  const filtered = [...latestByChildSessionKey.values()].filter((entry) => {
    const latestControllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
    return latestControllerSessionKey === key;
  });
  return sortSubagentRuns(filtered);
}

function ensureControllerOwnsRun(params: {
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const owner =
    params.entry.controllerSessionKey?.trim() ||
    params.entry.requesterSessionKey;
  if (owner === params.controller.controllerSessionKey) {
    return undefined;
  }
  return 'Subagents can only control runs spawned from their own session.';
}

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
}): Promise<{ killed: boolean; sessionId?: string }> {
  if (params.entry.endedAt) {
    return { killed: false };
  }
  const { childSessionKey } = params.entry;
  const resolved = resolveSessionEntryForKey({
    cache: params.cache,
    cfg: params.cfg,
    key: childSessionKey,
  });
  const sessionId = resolved.entry?.sessionId;
  const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
  const cleared = clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(',')}`,
    );
  }
  if (resolved.entry) {
    try {
      await updateSessionStore(resolved.storePath, (store) => {
        const current = store[childSessionKey];
        if (!current) {
          return;
        }
        current.abortedLastRun = true;
        current.updatedAt = Date.now();
        store[childSessionKey] = current;
      });
    } catch (error) {
      logVerbose(
        `subagents control kill: failed to persist abortedLastRun for ${childSessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const marked = markSubagentRunTerminated({
    childSessionKey,
    reason: 'killed',
    runId: params.entry.runId,
  });
  const killed =
    marked > 0 ||
    aborted ||
    cleared.followupCleared > 0 ||
    cleared.laneCleared > 0;
  return { killed, sessionId };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
}): Promise<{ killed: number; labels: string[] }> {
  const childRunsBySessionKey = new Map<string, SubagentRunRecord>();
  for (const run of listSubagentRunsForController(
    params.parentChildSessionKey,
  )) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey) {
      continue;
    }
    const latest = getLatestSubagentRunByChildSessionKey(childKey);
    const latestControllerSessionKey =
      latest?.controllerSessionKey?.trim() ||
      latest?.requesterSessionKey?.trim();
    if (
      !latest ||
      latest.runId !== run.runId ||
      latestControllerSessionKey !== params.parentChildSessionKey
    ) {
      continue;
    }
    const existing = childRunsBySessionKey.get(childKey);
    if (!existing || run.createdAt >= existing.createdAt) {
      childRunsBySessionKey.set(childKey, run);
    }
  }
  const childRuns = [...childRunsBySessionKey.values()];
  const seenChildSessionKeys = params.seenChildSessionKeys ?? new Set<string>();
  let killed = 0;
  const labels: string[] = [];

  for (const run of childRuns) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!run.endedAt) {
      const stopResult = await killSubagentRun({
        cache: params.cache,
        cfg: params.cfg,
        entry: run,
      });
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(run));
      }
    }

    const cascade = await cascadeKillChildren({
      cache: params.cache,
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }

  return { killed, labels };
}

export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
}) {
  if (params.controller.controlScope !== 'children') {
    return {
      error: 'Leaf subagents cannot control other sessions.',
      killed: 0,
      labels: [],
      status: 'forbidden' as const,
    };
  }
  const cache = new Map<string, Record<string, SessionEntry>>();
  const seenChildSessionKeys = new Set<string>();
  const killedLabels: string[] = [];
  let killed = 0;
  for (const entry of params.runs) {
    const childKey = entry.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    const currentEntry = getLatestSubagentRunByChildSessionKey(childKey);
    if (!currentEntry || currentEntry.runId !== entry.runId) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!currentEntry.endedAt) {
      const stopResult = await killSubagentRun({
        cache,
        cfg: params.cfg,
        entry: currentEntry,
      });
      if (stopResult.killed) {
        killed += 1;
        killedLabels.push(resolveSubagentLabel(currentEntry));
      }
    }

    const cascade = await cascadeKillChildren({
      cache,
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    killedLabels.push(...cascade.labels);
  }
  return { killed, labels: killedLabels, status: 'ok' as const };
}

export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      error: ownershipError,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'forbidden' as const,
    };
  }
  if (params.controller.controlScope !== 'children') {
    return {
      error: 'Leaf subagents cannot control other sessions.',
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'forbidden' as const,
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(
    params.entry.childSessionKey,
  );
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      label: resolveSubagentLabel(params.entry),
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'done' as const,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cache: killCache,
    cfg: params.cfg,
    entry: currentEntry,
  });
  const seenChildSessionKeys = new Set<string>();
  const targetChildKey = params.entry.childSessionKey?.trim();
  if (targetChildKey) {
    seenChildSessionKeys.add(targetChildKey);
  }
  const cascade = await cascadeKillChildren({
    cache: killCache,
    cfg: params.cfg,
    parentChildSessionKey: params.entry.childSessionKey,
    seenChildSessionKeys,
  });
  if (!stopResult.killed && cascade.killed === 0) {
    return {
      label: resolveSubagentLabel(params.entry),
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'done' as const,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const cascadeText =
    cascade.killed > 0
      ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? '' : 's'})`
      : '';
  return {
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    label: resolveSubagentLabel(params.entry),
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    status: 'ok' as const,
    text: stopResult.killed
      ? `killed ${resolveSubagentLabel(params.entry)}${cascadeText}.`
      : `killed ${cascade.killed} descendant${cascade.killed === 1 ? '' : 's'} of ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function killSubagentRunAdmin(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}) {
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return { found: false as const, killed: false };
  }
  const entry = getLatestSubagentRunByChildSessionKey(targetSessionKey);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cache: killCache,
    cfg: params.cfg,
    entry,
  });
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cache: killCache,
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    seenChildSessionKeys,
  });

  return {
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
  };
}

export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<
  | {
      status: 'forbidden' | 'done' | 'rate_limited' | 'error';
      runId?: string;
      sessionKey: string;
      sessionId?: string;
      error?: string;
      text?: string;
    }
  | {
      status: 'accepted';
      runId: string;
      sessionKey: string;
      sessionId?: string;
      mode: 'restart';
      label: string;
      text: string;
    }
> {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      error: ownershipError,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'forbidden',
    };
  }
  if (params.controller.controlScope !== 'children') {
    return {
      error: 'Leaf subagents cannot control other sessions.',
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'forbidden',
    };
  }
  const targetHasPendingDescendants =
    countPendingDescendantRuns(params.entry.childSessionKey) > 0;
  if (params.entry.endedAt && !targetHasPendingDescendants) {
    return {
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'done',
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  if (params.controller.callerSessionKey === params.entry.childSessionKey) {
    return {
      error: 'Subagents cannot steer themselves.',
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'forbidden',
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(
    params.entry.childSessionKey,
  );
  const currentHasPendingDescendants =
    currentEntry &&
    countPendingDescendantRuns(currentEntry.childSessionKey) > 0;
  if (
    !currentEntry ||
    currentEntry.runId !== params.entry.runId ||
    (currentEntry.endedAt && !currentHasPendingDescendants)
  ) {
    return {
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      status: 'done',
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }

  const rateKey = `${params.controller.callerSessionKey}:${params.entry.childSessionKey}`;
  if (process.env.VITEST !== 'true') {
    const now = Date.now();
    const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
    if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
      return {
        error:
          'Steer rate limit exceeded. Wait a moment before sending another steer.',
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        status: 'rate_limited',
      };
    }
    steerRateLimit.set(rateKey, now);
  }

  markSubagentRunForSteerRestart(params.entry.runId);

  const targetSession = resolveSessionEntryForKey({
    cache: new Map<string, Record<string, SessionEntry>>(),
    cfg: params.cfg,
    key: params.entry.childSessionKey,
  });
  const sessionId =
    typeof targetSession.entry?.sessionId === 'string' &&
    targetSession.entry.sessionId.trim()
      ? targetSession.entry.sessionId.trim()
      : undefined;

  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }
  const cleared = clearSessionQueues([params.entry.childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(',')}`,
    );
  }

  try {
    await subagentControlDeps.callGateway({
      method: 'agent.wait',
      params: {
        runId: params.entry.runId,
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
      },
      timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2000,
    });
  } catch {
    // Continue even if wait fails; steer should still be attempted.
  }

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: 'agent',
      params: {
        channel: INTERNAL_MESSAGE_CHANNEL,
        deliver: false,
        idempotencyKey,
        lane: AGENT_LANE_SUBAGENT,
        message: params.message,
        sessionId,
        sessionKey: params.entry.childSessionKey,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === 'string' && response.runId) {
      ({ runId } = response);
    }
  } catch (error) {
    clearSubagentRunSteerRestart(params.entry.runId);
    const formattedError = formatErrorMessage(error);
    return {
      error: formattedError,
      runId,
      sessionId,
      sessionKey: params.entry.childSessionKey,
      status: 'error',
    };
  }

  const replaced = replaceSubagentRunAfterSteer({
    fallback: params.entry,
    nextRunId: runId,
    previousRunId: params.entry.runId,
    runTimeoutSeconds: params.entry.runTimeoutSeconds ?? 0,
  });
  if (!replaced) {
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      error: 'failed to replace steered subagent run',
      runId,
      sessionId,
      sessionKey: params.entry.childSessionKey,
      status: 'error',
    };
  }

  return {
    label: resolveSubagentLabel(params.entry),
    mode: 'restart',
    runId,
    sessionId,
    sessionKey: params.entry.childSessionKey,
    status: 'accepted',
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

export async function sendControlledSubagentMessage(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return { error: ownershipError, status: 'forbidden' as const };
  }
  if (params.controller.controlScope !== 'children') {
    return {
      error: 'Leaf subagents cannot control other sessions.',
      status: 'forbidden' as const,
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(
    params.entry.childSessionKey,
  );
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      runId: params.entry.runId,
      status: 'done' as const,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }

  const targetSessionKey = params.entry.childSessionKey;
  const parsed = parseAgentSessionKey(targetSessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  const store = loadSessionStore(storePath);
  const targetSessionEntry = store[targetSessionKey];
  const targetSessionId =
    typeof targetSessionEntry?.sessionId === 'string' &&
    targetSessionEntry.sessionId.trim()
      ? targetSessionEntry.sessionId.trim()
      : undefined;

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const baselineReply = await readLatestAssistantReplySnapshot({
      callGateway: subagentControlDeps.callGateway,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      sessionKey: targetSessionKey,
    });

    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: 'agent',
      params: {
        channel: INTERNAL_MESSAGE_CHANNEL,
        deliver: false,
        idempotencyKey,
        lane: AGENT_LANE_SUBAGENT,
        message: params.message,
        sessionId: targetSessionId,
        sessionKey: targetSessionKey,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    const responseRunId =
      typeof response?.runId === 'string' ? response.runId : undefined;
    if (responseRunId) {
      runId = responseRunId;
    }

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      baseline: baselineReply,
      callGateway: subagentControlDeps.callGateway,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      runId,
      sessionKey: targetSessionKey,
      timeoutMs: 30_000,
    });
    if (result.status === 'timeout') {
      return { runId, status: 'timeout' as const };
    }
    if (result.status === 'error') {
      return {
        error: result.error ?? 'unknown error',
        runId,
        status: 'error' as const,
      };
    }
    return { replyText: result.replyText, runId, status: 'ok' as const };
  } catch (error) {
    const formattedError = formatErrorMessage(error);
    return { error: formattedError, runId, status: 'error' as const };
  }
}

export function resolveControlledSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
  options?: {
    recentMinutes?: number;
    isActive?: (entry: SubagentRunRecord) => boolean;
  },
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    errors: {
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) =>
        `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) =>
        `Ambiguous subagent run id prefix: ${value}`,
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      missingTarget: 'Missing subagent target.',
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      unknownTarget: (value) => `Unknown subagent target: ${value}`,
    },
    isActive: options?.isActive,
    label: (entry) => resolveSubagentLabel(entry),
    recentWindowMinutes: options?.recentMinutes ?? DEFAULT_RECENT_MINUTES,
    runs,
    token,
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    subagentControlDeps = overrides
      ? {
          ...defaultSubagentControlDeps,
          ...overrides,
        }
      : defaultSubagentControlDeps;
  },
};
