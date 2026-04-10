import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  findTaskByRunId,
  getTaskById,
  listTasksForRelatedSessionKey,
  resolveTaskForLookupToken,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

function canOwnerAccessTask(task: TaskRecord, callerOwnerKey: string): boolean {
  return (
    task.scopeKind === "session" &&
    normalizeOptionalString(task.ownerKey) === normalizeOptionalString(callerOwnerKey)
  );
}

export function getTaskByIdForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  const task = getTaskById(params.taskId);
  return task && canOwnerAccessTask(task, params.callerOwnerKey) ? task : undefined;
}

export function findTaskByRunIdForOwner(params: {
  runId: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  const task = findTaskByRunId(params.runId);
  return task && canOwnerAccessTask(task, params.callerOwnerKey) ? task : undefined;
}

export function listTasksForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): TaskRecord[] {
  return listTasksForRelatedSessionKey(params.relatedSessionKey).filter((task) =>
    canOwnerAccessTask(task, params.callerOwnerKey),
  );
}

export function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}) {
  return buildTaskStatusSnapshot(
    listTasksForRelatedSessionKeyForOwner({
      callerOwnerKey: params.callerOwnerKey,
      relatedSessionKey: params.relatedSessionKey,
    }),
  );
}

export function findLatestTaskForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  return listTasksForRelatedSessionKeyForOwner(params)[0];
}

export function resolveTaskForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  const direct = getTaskByIdForOwner({
    callerOwnerKey: params.callerOwnerKey,
    taskId: params.token,
  });
  if (direct) {
    return direct;
  }
  const byRun = findTaskByRunIdForOwner({
    callerOwnerKey: params.callerOwnerKey,
    runId: params.token,
  });
  if (byRun) {
    return byRun;
  }
  const related = findLatestTaskForRelatedSessionKeyForOwner({
    callerOwnerKey: params.callerOwnerKey,
    relatedSessionKey: params.token,
  });
  if (related) {
    return related;
  }
  const raw = resolveTaskForLookupToken(params.token);
  return raw && canOwnerAccessTask(raw, params.callerOwnerKey) ? raw : undefined;
}
