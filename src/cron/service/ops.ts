import { enqueueCommandInLane } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import {
  applyJobPatch,
  assertSupportedJobSpec,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  hasScheduledNextRunAtMs,
  isJobDue,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRuns,
  recomputeNextRunsForMaintenance,
} from "./jobs.js";
import { locked } from "./locked.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, persist, warnIfDisabled } from "./store.js";
import {
  applyJobResult,
  armTimer,
  emit,
  executeJobCoreWithTimeout,
  normalizeCronRunErrorText,
  runMissedJobs,
  stopTimer,
  wake,
} from "./timer.js";

type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
type CronSortDir = "asc" | "desc";

export interface CronListPageOptions {
  includeDisabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
  enabled?: CronJobsEnabledFilter;
  sortBy?: CronJobsSortBy;
  sortDir?: CronSortDir;
}

export interface CronListPageResult {
  jobs: ReturnType<typeof sortJobs>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}
function mergeManualRunSnapshotAfterReload(params: {
  state: CronServiceState;
  jobId: string;
  snapshot: {
    enabled: boolean;
    updatedAtMs: number;
    state: CronJob["state"];
  } | null;
  removed: boolean;
}) {
  if (!params.state.store) {
    return;
  }
  if (params.removed) {
    params.state.store.jobs = params.state.store.jobs.filter((job) => job.id !== params.jobId);
    return;
  }
  if (!params.snapshot) {
    return;
  }
  const reloaded = params.state.store.jobs.find((job) => job.id === params.jobId);
  if (!reloaded) {
    return;
  }
  reloaded.enabled = params.snapshot.enabled;
  reloaded.updatedAtMs = params.snapshot.updatedAtMs;
  reloaded.state = params.snapshot.state;
}

async function ensureLoadedForRead(state: CronServiceState) {
  await ensureLoaded(state, { skipRecompute: true });
  if (!state.store) {
    return;
  }
  // Use the maintenance-only version so that read-only operations never
  // Advance a past-due nextRunAtMs without executing the job (#16156).
  const changed = recomputeNextRunsForMaintenance(state);
  if (changed) {
    await persist(state);
  }
}

export async function start(state: CronServiceState) {
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const interruptedOneShotIds = new Set<string>();
  let clearedAnyRunningMarker = false;
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const jobs = state.store?.jobs ?? [];
    for (const job of jobs) {
      if (typeof job.state.runningAtMs === "number") {
        state.deps.log.warn(
          { jobId: job.id, runningAtMs: job.state.runningAtMs },
          "cron: clearing stale running marker on startup",
        );
        job.state.runningAtMs = undefined;
        clearedAnyRunningMarker = true;
        // One-shot jobs are not retried after interruption; recurring jobs
        // (cron/every) are eligible for startup catch-up so they don't
        // Require a second restart to recover (#60495).
        if (job.schedule.kind === "at") {
          interruptedOneShotIds.add(job.id);
        }
      }
    }
    if (clearedAnyRunningMarker) {
      await persist(state);
    }
  });

  await runMissedJobs(state, {
    skipJobIds: interruptedOneShotIds.size > 0 ? interruptedOneShotIds : undefined,
  });

  await locked(state, async () => {
    // Startup catch-up already persisted the latest in-memory store state, and
    // This path runs before the scheduler begins servicing regular timer ticks.
    // Avoid an extra reload/write cycle on startup.
    await ensureLoaded(state, { skipRecompute: true });
    const changed = recomputeNextRuns(state);
    if (changed) {
      await persist(state);
    }
    armTimer(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

export function stop(state: CronServiceState) {
  stopTimer(state);
}

export async function status(state: CronServiceState) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    return {
      enabled: state.deps.cronEnabled,
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
      storePath: state.deps.storePath,
    };
  });
}

export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean }) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || isJobEnabled(j));
    return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
  });
}

function resolveEnabledFilter(opts?: CronListPageOptions): CronJobsEnabledFilter {
  if (opts?.enabled === "all" || opts?.enabled === "enabled" || opts?.enabled === "disabled") {
    return opts.enabled;
  }
  return opts?.includeDisabled ? "all" : "enabled";
}

function sortJobs(jobs: CronJob[], sortBy: CronJobsSortBy, sortDir: CronSortDir) {
  const dir = sortDir === "desc" ? -1 : 1;
  return jobs.toSorted((a, b) => {
    let cmp = 0;
    if (sortBy === "name") {
      const aName = typeof a.name === "string" ? a.name : "";
      const bName = typeof b.name === "string" ? b.name : "";
      cmp = aName.localeCompare(bName, undefined, { sensitivity: "base" });
    } else if (sortBy === "updatedAtMs") {
      cmp = a.updatedAtMs - b.updatedAtMs;
    } else {
      const aNext = a.state.nextRunAtMs;
      const bNext = b.state.nextRunAtMs;
      if (typeof aNext === "number" && typeof bNext === "number") {
        cmp = aNext - bNext;
      } else if (typeof aNext === "number") {
        cmp = -1;
      } else if (typeof bNext === "number") {
        cmp = 1;
      } else {
        cmp = 0;
      }
    }
    if (cmp !== 0) {
      return cmp * dir;
    }
    const aId = typeof a.id === "string" ? a.id : "";
    const bId = typeof b.id === "string" ? b.id : "";
    return aId.localeCompare(bId);
  });
}

export async function listPage(state: CronServiceState, opts?: CronListPageOptions) {
  return await locked(state, async () => {
    await ensureLoadedForRead(state);
    const query = normalizeLowercaseStringOrEmpty(opts?.query);
    const enabledFilter = resolveEnabledFilter(opts);
    const sortBy = opts?.sortBy ?? "nextRunAtMs";
    const sortDir = opts?.sortDir ?? "asc";
    const source = state.store?.jobs ?? [];
    const filtered = source.filter((job) => {
      if (enabledFilter === "enabled" && !isJobEnabled(job)) {
        return false;
      }
      if (enabledFilter === "disabled" && isJobEnabled(job)) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = normalizeLowercaseStringOrEmpty(
        [job.name, job.description ?? "", job.agentId ?? ""].join(" "),
      );
      return haystack.includes(query);
    });
    const sorted = sortJobs(filtered, sortBy, sortDir);
    const total = sorted.length;
    const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
    const defaultLimit = total === 0 ? 50 : total;
    const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? defaultLimit)));
    const jobs = sorted.slice(offset, offset + limit);
    const nextOffset = offset + jobs.length;
    return {
      hasMore: nextOffset < total,
      jobs,
      limit,
      nextOffset: nextOffset < total ? nextOffset : null,
      offset,
      total,
    } satisfies CronListPageResult;
  });
}

export async function add(state: CronServiceState, input: CronJobCreate) {
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    await ensureLoaded(state);
    const job = createJob(state, input);
    state.store?.jobs.push(job);

    // Defensive: recompute all next-run times to ensure consistency
    recomputeNextRuns(state);

    await persist(state);
    armTimer(state);

    state.deps.log.info(
      {
        cronEnabled: state.deps.cronEnabled,
        jobId: job.id,
        jobName: job.name,
        nextRunAtMs: job.state.nextRunAtMs,
        schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
        timerArmed: state.timer !== null,
      },
      "cron: job added",
    );

    emit(state, {
      action: "added",
      jobId: job.id,
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function update(state: CronServiceState, id: string, patch: CronJobPatch) {
  return await locked(state, async () => {
    warnIfDisabled(state, "update");
    await ensureLoaded(state, { skipRecompute: true });
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();
    applyJobPatch(job, patch, { defaultAgentId: state.deps.defaultAgentId });
    if (job.schedule.kind === "every") {
      const anchor = job.schedule.anchorMs;
      if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
        const patchSchedule = patch.schedule;
        const fallbackAnchorMs =
          patchSchedule?.kind === "every"
            ? now
            : (typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
              ? job.createdAtMs
              : now);
        job.schedule = {
          ...job.schedule,
          anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
        };
      }
    }
    const scheduleChanged = patch.schedule !== undefined;
    const enabledChanged = patch.enabled !== undefined;

    job.updatedAtMs = now;
    if (scheduleChanged || enabledChanged) {
      if (isJobEnabled(job)) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
      } else {
        job.state.nextRunAtMs = undefined;
        job.state.runningAtMs = undefined;
      }
    } else if (isJobEnabled(job) && !hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
    }

    await persist(state);
    armTimer(state);
    emit(state, {
      action: "updated",
      jobId: id,
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function remove(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove");
    await ensureLoaded(state);
    const before = state.store?.jobs.length ?? 0;
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
    const removed = (state.store.jobs.length ?? 0) !== before;
    await persist(state);
    armTimer(state);
    if (removed) {
      emit(state, { action: "removed", jobId: id });
    }
    return { ok: true, removed } as const;
  });
}

type PreparedManualRun =
  | {
      ok: true;
      ran: false;
      reason: "already-running" | "not-due" | "invalid-spec";
    }
  | {
      ok: true;
      ran: true;
      jobId: string;
      taskRunId?: string;
      startedAt: number;
      executionJob: CronJob;
    }
  | { ok: false };

type ManualRunDisposition =
  | Extract<PreparedManualRun, { ran: false }>
  | { ok: true; runnable: true };

type ManualRunPreflightResult =
  | { ok: false }
  | Extract<PreparedManualRun, { ran: false }>
  | {
      ok: true;
      runnable: true;
      job: CronJob;
      now: number;
    };

let nextManualRunId = 1;

function createCronTaskRunId(jobId: string, startedAt: number): string {
  return `cron:${jobId}:${startedAt}`;
}

async function skipInvalidPersistedManualRun(params: {
  state: CronServiceState;
  job: CronJob;
  mode?: "due" | "force";
  error: unknown;
}) {
  const endedAt = params.state.deps.nowMs();
  const errorText = normalizeCronRunErrorText(params.error);
  const shouldDelete = applyJobResult(
    params.state,
    params.job,
    {
      endedAt,
      error: errorText,
      startedAt: endedAt,
      status: "skipped",
    },
    { preserveSchedule: params.mode === "force" },
  );

  emit(params.state, {
    action: "finished",
    deliveryError: params.job.state.lastDeliveryError,
    deliveryStatus: params.job.state.lastDeliveryStatus,
    durationMs: params.job.state.lastDurationMs,
    error: errorText,
    jobId: params.job.id,
    nextRunAtMs: params.job.state.nextRunAtMs,
    runAtMs: endedAt,
    status: "skipped",
  });

  if (shouldDelete && params.state.store) {
    params.state.store.jobs = params.state.store.jobs.filter((entry) => entry.id !== params.job.id);
    emit(params.state, { action: "removed", jobId: params.job.id });
  }

  recomputeNextRunsForMaintenance(params.state, { recomputeExpired: true });
  await persist(params.state);
  armTimer(params.state);
}

function tryCreateManualTaskRun(params: {
  state: CronServiceState;
  job: CronJob;
  startedAt: number;
}): string | undefined {
  const runId = createCronTaskRunId(params.job.id, params.startedAt);
  try {
    createRunningTaskRun({
      agentId: params.job.agentId,
      childSessionKey: params.job.sessionKey,
      deliveryStatus: "not_applicable",
      label: params.job.name,
      lastEventAt: params.startedAt,
      notifyPolicy: "silent",
      ownerKey: "",
      runId,
      runtime: "cron",
      scopeKind: "system",
      sourceId: params.job.id,
      startedAt: params.startedAt,
      task: params.job.name || params.job.id,
    });
    return runId;
  } catch (error) {
    params.state.deps.log.warn(
      { error, jobId: params.job.id },
      "cron: failed to create task ledger record",
    );
    return undefined;
  }
}

function tryFinishManualTaskRun(
  state: CronServiceState,
  params: {
    taskRunId?: string;
    coreResult: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
    endedAt: number;
  },
): void {
  if (!params.taskRunId) {
    return;
  }
  try {
    if (params.coreResult.status === "ok" || params.coreResult.status === "skipped") {
      completeTaskRunByRunId({
        endedAt: params.endedAt,
        lastEventAt: params.endedAt,
        runId: params.taskRunId,
        runtime: "cron",
        terminalSummary: params.coreResult.summary ?? undefined,
      });
      return;
    }
    failTaskRunByRunId({
      endedAt: params.endedAt,
      error:
        params.coreResult.status === "error"
          ? normalizeCronRunErrorText(params.coreResult.error)
          : undefined,
      lastEventAt: params.endedAt,
      runId: params.taskRunId,
      runtime: "cron",
      status:
        normalizeCronRunErrorText(params.coreResult.error) === "cron: job execution timed out"
          ? "timed_out"
          : "failed",
      terminalSummary: params.coreResult.summary ?? undefined,
    });
  } catch (error) {
    state.deps.log.warn(
      { error, jobStatus: params.coreResult.status, runId: params.taskRunId },
      "cron: failed to update task ledger record",
    );
  }
}

async function inspectManualRunPreflight(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
): Promise<ManualRunPreflightResult> {
  return await locked(state, async () => {
    warnIfDisabled(state, "run");
    await ensureLoaded(state, { skipRecompute: true });
    // Normalize job tick state (clears stale runningAtMs markers) before
    // Checking if already running, so a stale marker from a crashed Phase-1
    // Persist does not block manual triggers for up to STUCK_RUN_MS (#17554).
    recomputeNextRunsForMaintenance(state);
    const job = findJobOrThrow(state, id);
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      await skipInvalidPersistedManualRun({ error, job, mode, state });
      return { ok: true, ran: false, reason: "invalid-spec" as const };
    }
    if (typeof job.state.runningAtMs === "number") {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    const now = state.deps.nowMs();
    const due = isJobDue(job, now, { forced: mode === "force" });
    if (!due) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    return { job, now, ok: true, runnable: true } as const;
  });
}

async function inspectManualRunDisposition(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
): Promise<ManualRunDisposition | { ok: false }> {
  const result = await inspectManualRunPreflight(state, id, mode);
  if (!result.ok) {
    return result;
  }
  if ("reason" in result) {
    return result;
  }
  return { ok: true, runnable: true } as const;
}

async function prepareManualRun(
  state: CronServiceState,
  id: string,
  mode?: "due" | "force",
): Promise<PreparedManualRun> {
  const preflight = await inspectManualRunPreflight(state, id, mode);
  if (!preflight.ok) {
    return preflight;
  }
  if ("reason" in preflight) {
    return {
      ok: true,
      ran: false,
      reason: preflight.reason,
    } as const;
  }
  return await locked(state, async () => {
    // Reserve this run under lock, then execute outside lock so read ops
    // (`list`, `status`) stay responsive while the run is in progress.
    const job = findJobOrThrow(state, id);
    if (typeof job.state.runningAtMs === "number") {
      return { ok: true, ran: false, reason: "already-running" as const };
    }
    job.state.runningAtMs = preflight.now;
    job.state.lastError = undefined;
    // Persist the running marker before releasing lock so timer ticks that
    // Force-reload from disk cannot start the same job concurrently.
    await persist(state);
    emit(state, { action: "started", jobId: job.id, runAtMs: preflight.now });
    const taskRunId = tryCreateManualTaskRun({
      job,
      startedAt: preflight.now,
      state,
    });
    const executionJob = JSON.parse(JSON.stringify(job)) as CronJob;
    return {
      executionJob,
      jobId: job.id,
      ok: true,
      ran: true,
      startedAt: preflight.now,
      taskRunId,
    } as const;
  });
}

async function finishPreparedManualRun(
  state: CronServiceState,
  prepared: Extract<PreparedManualRun, { ran: true }>,
  mode?: "due" | "force",
): Promise<void> {
  const {executionJob} = prepared;
  const {startedAt} = prepared;
  const {jobId} = prepared;
  const {taskRunId} = prepared;

  let coreResult: Awaited<ReturnType<typeof executeJobCoreWithTimeout>>;
  try {
    coreResult = await executeJobCoreWithTimeout(state, executionJob);
  } catch (error) {
    coreResult = { error: normalizeCronRunErrorText(error), status: "error" };
  }
  const endedAt = state.deps.nowMs();
  tryFinishManualTaskRun(state, {
    coreResult,
    endedAt,
    taskRunId,
  });

  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const job = state.store?.jobs.find((entry) => entry.id === jobId);
    if (!job) {
      return;
    }

    const shouldDelete = applyJobResult(
      state,
      job,
      {
        delivered: coreResult.delivered,
        endedAt,
        error: coreResult.error,
        startedAt,
        status: coreResult.status,
      },
      { preserveSchedule: mode === "force" },
    );

    emit(state, {
      action: "finished",
      delivered: coreResult.delivered,
      deliveryError: job.state.lastDeliveryError,
      deliveryStatus: job.state.lastDeliveryStatus,
      durationMs: job.state.lastDurationMs,
      error: coreResult.error,
      jobId: job.id,
      model: coreResult.model,
      nextRunAtMs: job.state.nextRunAtMs,
      provider: coreResult.provider,
      runAtMs: startedAt,
      sessionId: coreResult.sessionId,
      sessionKey: coreResult.sessionKey,
      status: coreResult.status,
      summary: coreResult.summary,
      usage: coreResult.usage,
    });

    if (shouldDelete && state.store) {
      state.store.jobs = state.store.jobs.filter((entry) => entry.id !== job.id);
      emit(state, { action: "removed", jobId: job.id });
    }

    // Manual runs should not advance other due jobs without executing them.
    // Use maintenance-only recompute to repair missing values while
    // Preserving existing past-due nextRunAtMs entries for future timer ticks.
    const postRunSnapshot = shouldDelete
      ? null
      : {
          enabled: job.enabled,
          state: structuredClone(job.state),
          updatedAtMs: job.updatedAtMs,
        };
    const postRunRemoved = shouldDelete;
    // Isolated Telegram send can persist target writeback directly to disk.
    // Reload before final persist so manual `cron run` keeps those changes.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    mergeManualRunSnapshotAfterReload({
      jobId,
      removed: postRunRemoved,
      snapshot: postRunSnapshot,
      state,
    });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
    await persist(state);
    armTimer(state);
  });
}

export async function run(state: CronServiceState, id: string, mode?: "due" | "force") {
  const prepared = await prepareManualRun(state, id, mode);
  if (!prepared.ok || !prepared.ran) {
    return prepared;
  }
  await finishPreparedManualRun(state, prepared, mode);
  return { ok: true, ran: true } as const;
}

export async function enqueueRun(state: CronServiceState, id: string, mode?: "due" | "force") {
  const disposition = await inspectManualRunDisposition(state, id, mode);
  if (!disposition.ok || !("runnable" in disposition && disposition.runnable)) {
    return disposition;
  }

  const runId = `manual:${id}:${state.deps.nowMs()}:${nextManualRunId++}`;
  void enqueueCommandInLane(
    CommandLane.Cron,
    async () => {
      const result = await run(state, id, mode);
      if (result.ok && "ran" in result && !result.ran) {
        state.deps.log.info(
          { jobId: id, reason: result.reason, runId },
          "cron: queued manual run skipped before execution",
        );
      }
      return result;
    },
    {
      onWait: (waitMs, queuedAhead) => {
        state.deps.log.warn(
          { jobId: id, queuedAhead, runId, waitMs },
          "cron: queued manual run waiting for an execution slot",
        );
      },
      warnAfterMs: 5000,
    },
  ).catch((error) => {
    state.deps.log.error(
      { err: String(error), jobId: id, runId },
      "cron: queued manual run background execution failed",
    );
  });
  return { enqueued: true, ok: true, runId } as const;
}

export function wakeNow(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  return wake(state, opts);
}
