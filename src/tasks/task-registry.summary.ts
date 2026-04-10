import type {
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntimeCounts,
  TaskStatusCounts,
} from "./task-registry.types.js";

function createEmptyTaskStatusCounts(): TaskStatusCounts {
  return {
    cancelled: 0,
    failed: 0,
    lost: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    timed_out: 0,
  };
}

function createEmptyTaskRuntimeCounts(): TaskRuntimeCounts {
  return {
    acp: 0,
    cli: 0,
    cron: 0,
    subagent: 0,
  };
}

export function createEmptyTaskRegistrySummary(): TaskRegistrySummary {
  return {
    active: 0,
    byRuntime: createEmptyTaskRuntimeCounts(),
    byStatus: createEmptyTaskStatusCounts(),
    failures: 0,
    terminal: 0,
    total: 0,
  };
}

export function summarizeTaskRecords(records: Iterable<TaskRecord>): TaskRegistrySummary {
  const summary = createEmptyTaskRegistrySummary();
  for (const task of records) {
    summary.total += 1;
    summary.byStatus[task.status] += 1;
    summary.byRuntime[task.runtime] += 1;
    if (task.status === "queued" || task.status === "running") {
      summary.active += 1;
    } else {
      summary.terminal += 1;
    }
    if (task.status === "failed" || task.status === "timed_out" || task.status === "lost") {
      summary.failures += 1;
    }
  }
  return summary;
}
