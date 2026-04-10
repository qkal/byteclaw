import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  cancelTaskById,
  createTaskRecord,
  findLatestTaskForFlowId,
  isParentFlowLinkError,
  linkTaskToFlowById,
  listTasksForFlowId,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalByRunId,
  recordTaskProgressByRunId,
  setTaskRunDeliveryStatusByRunId,
} from "./runtime-internal.js";
import { getTaskFlowByIdForOwner } from "./task-flow-owner-access.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  getTaskFlowById,
  requestFlowCancel,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");

function isOneTaskFlowEligible(task: TaskRecord): boolean {
  if (task.parentFlowId?.trim() || task.scopeKind !== "session") {
    return false;
  }
  if (task.deliveryStatus === "not_applicable") {
    return false;
  }
  return task.runtime === "acp" || task.runtime === "subagent";
}

function ensureSingleTaskFlow(params: {
  task: TaskRecord;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): TaskRecord {
  if (!isOneTaskFlowEligible(params.task)) {
    return params.task;
  }
  try {
    const flow = createTaskFlowForTask({
      requesterOrigin: params.requesterOrigin,
      task: params.task,
    });
    const linked = linkTaskToFlowById({
      flowId: flow.flowId,
      taskId: params.task.taskId,
    });
    if (!linked) {
      deleteTaskFlowRecordById(flow.flowId);
      return params.task;
    }
    if (linked.parentFlowId !== flow.flowId) {
      deleteTaskFlowRecordById(flow.flowId);
      return linked;
    }
    return linked;
  } catch (error) {
    log.warn("Failed to create one-task flow for detached run", {
      error,
      runId: params.task.runId,
      taskId: params.task.taskId,
    });
    return params.task;
  }
}

export function createQueuedTaskRun(params: {
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  parentFlowId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
}): TaskRecord {
  const task = createTaskRecord({
    ...params,
    status: "queued",
  });
  return ensureSingleTaskFlow({
    requesterOrigin: params.requesterOrigin,
    task,
  });
}

export function getFlowTaskSummary(flowId: string): TaskRegistrySummary {
  return summarizeTaskRecords(listTasksForFlowId(flowId));
}

export function createRunningTaskRun(params: {
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  parentFlowId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  preferMetadata?: boolean;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}): TaskRecord {
  const task = createTaskRecord({
    ...params,
    status: "running",
  });
  return ensureSingleTaskFlow({
    requesterOrigin: params.requesterOrigin,
    task,
  });
}

export function startTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return markTaskRunningByRunId(params);
}

export function recordTaskRunProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return recordTaskProgressByRunId(params);
}

export function completeTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  endedAt: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}) {
  return markTaskTerminalByRunId({
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: "succeeded",
    terminalOutcome: params.terminalOutcome,
    terminalSummary: params.terminalSummary,
  });
}

export function failTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status?: Extract<TaskStatus, "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
}) {
  return markTaskTerminalByRunId({
    endedAt: params.endedAt,
    error: params.error,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: params.status ?? "failed",
    terminalSummary: params.terminalSummary,
  });
}

export function markTaskRunLostById(params: {
  taskId: string;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  cleanupAfter?: number;
}) {
  return markTaskLostById(params);
}

export function setDetachedTaskDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
}) {
  return setTaskRunDeliveryStatusByRunId(params);
}

interface RetryBlockedFlowResult {
  found: boolean;
  retried: boolean;
  reason?: string;
  previousTask?: TaskRecord;
  task?: TaskRecord;
}

interface RetryBlockedFlowParams {
  flowId: string;
  sourceId?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task?: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}

function resolveRetryableBlockedFlowTask(flowId: string): {
  flowFound: boolean;
  retryable: boolean;
  latestTask?: TaskRecord;
  reason?: string;
} {
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return {
      flowFound: false,
      reason: "Flow not found.",
      retryable: false,
    };
  }
  const latestTask = findLatestTaskForFlowId(flowId);
  if (!latestTask) {
    return {
      flowFound: true,
      reason: "Flow has no retryable task.",
      retryable: false,
    };
  }
  if (flow.status !== "blocked") {
    return {
      flowFound: true,
      latestTask,
      reason: "Flow is not blocked.",
      retryable: false,
    };
  }
  if (latestTask.status !== "succeeded" || latestTask.terminalOutcome !== "blocked") {
    return {
      flowFound: true,
      latestTask,
      reason: "Latest TaskFlow task is not blocked.",
      retryable: false,
    };
  }
  return {
    flowFound: true,
    latestTask,
    retryable: true,
  };
}

function retryBlockedFlowTask(params: RetryBlockedFlowParams): RetryBlockedFlowResult {
  const resolved = resolveRetryableBlockedFlowTask(params.flowId);
  if (!resolved.retryable || !resolved.latestTask) {
    return {
      found: resolved.flowFound,
      reason: resolved.reason,
      retried: false,
    };
  }
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      previousTask: resolved.latestTask,
      reason: "Flow not found.",
      retried: false,
    };
  }
  const task = createTaskRecord({
    agentId: params.agentId ?? resolved.latestTask.agentId,
    childSessionKey: params.childSessionKey,
    deliveryStatus: params.deliveryStatus ?? "pending",
    label: params.label ?? resolved.latestTask.label,
    lastEventAt: params.lastEventAt,
    notifyPolicy: params.notifyPolicy ?? resolved.latestTask.notifyPolicy,
    ownerKey: flow.ownerKey,
    parentFlowId: flow.flowId,
    parentTaskId: resolved.latestTask.taskId,
    preferMetadata: params.preferMetadata,
    progressSummary: params.progressSummary,
    requesterOrigin: params.requesterOrigin ?? flow.requesterOrigin,
    runId: params.runId,
    runtime: resolved.latestTask.runtime,
    scopeKind: "session",
    sourceId: params.sourceId ?? resolved.latestTask.sourceId,
    startedAt: params.startedAt,
    status: params.status,
    task: params.task ?? resolved.latestTask.task,
  });
  return {
    found: true,
    previousTask: resolved.latestTask,
    retried: true,
    task,
  };
}

export function retryBlockedFlowAsQueuedTaskRun(
  params: Omit<RetryBlockedFlowParams, "status" | "startedAt" | "lastEventAt" | "progressSummary">,
): RetryBlockedFlowResult {
  return retryBlockedFlowTask({
    ...params,
    status: "queued",
  });
}

export function retryBlockedFlowAsRunningTaskRun(
  params: Omit<RetryBlockedFlowParams, "status">,
): RetryBlockedFlowResult {
  return retryBlockedFlowTask({
    ...params,
    status: "running",
  });
}

interface CancelFlowResult {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
}

interface RunTaskInFlowResult {
  found: boolean;
  created: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  task?: TaskRecord;
}

function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function markFlowCancelRequested(flow: TaskFlowRecord): TaskFlowRecord | FlowUpdateFailure {
  if (flow.cancelRequestedAt != null) {
    return flow;
  }
  const result = requestFlowCancel({
    expectedRevision: flow.revision,
    flowId: flow.flowId,
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    flow: result.current ?? getTaskFlowById(flow.flowId),
    reason:
      result.reason === "revision_conflict"
        ? "Flow changed while cancellation was in progress."
        : "Flow not found.",
  };
}

interface FlowUpdateFailure {
  reason: string;
  flow?: TaskFlowRecord;
}

function cancelManagedFlowAfterChildrenSettle(
  flow: TaskFlowRecord,
  endedAt: number,
): TaskFlowRecord | FlowUpdateFailure {
  const result = updateFlowRecordByIdExpectedRevision({
    expectedRevision: flow.revision,
    flowId: flow.flowId,
    patch: {
      blockedSummary: null,
      blockedTaskId: null,
      endedAt,
      status: "cancelled",
      updatedAt: endedAt,
      waitJson: null,
    },
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    flow: result.current ?? getTaskFlowById(flow.flowId),
    reason:
      result.reason === "revision_conflict"
        ? "Flow changed while cancellation was in progress."
        : "Flow not found.",
  };
}

function mapRunTaskInFlowCreateError(params: {
  error: unknown;
  flowId: string;
}): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (isParentFlowLinkError(params.error)) {
    if (params.error.code === "cancel_requested") {
      return {
        created: false,
        found: true,
        reason: "Flow cancellation has already been requested.",
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "terminal") {
      const terminalStatus = flow?.status ?? params.error.details?.status ?? "terminal";
      return {
        created: false,
        found: true,
        reason: `Flow is already ${terminalStatus}.`,
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "parent_flow_not_found") {
      return {
        created: false,
        found: false,
        reason: "Flow not found.",
      };
    }
  }
  throw params.error;
}

export function runTaskInFlow(params: {
  flowId: string;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status?: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      created: false,
      found: false,
      reason: "Flow not found.",
    };
  }
  if (flow.syncMode !== "managed") {
    return {
      created: false,
      flow,
      found: true,
      reason: "Flow does not accept managed child tasks.",
    };
  }
  if (flow.cancelRequestedAt != null) {
    return {
      created: false,
      flow,
      found: true,
      reason: "Flow cancellation has already been requested.",
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      created: false,
      flow,
      found: true,
      reason: `Flow is already ${flow.status}.`,
    };
  }

  const common = {
    agentId: params.agentId,
    childSessionKey: params.childSessionKey,
    deliveryStatus: params.deliveryStatus ?? "pending",
    label: params.label,
    notifyPolicy: params.notifyPolicy,
    ownerKey: flow.ownerKey,
    parentFlowId: flow.flowId,
    parentTaskId: params.parentTaskId,
    preferMetadata: params.preferMetadata,
    requesterOrigin: flow.requesterOrigin,
    runId: params.runId,
    runtime: params.runtime,
    scopeKind: "session" as const,
    sourceId: params.sourceId,
    task: params.task,
  };
  let task: TaskRecord;
  try {
    task =
      params.status === "running"
        ? createRunningTaskRun({
            ...common,
            lastEventAt: params.lastEventAt,
            progressSummary: params.progressSummary,
            startedAt: params.startedAt,
          })
        : createQueuedTaskRun(common);
  } catch (error) {
    return mapRunTaskInFlowCreateError({
      error,
      flowId: flow.flowId,
    });
  }

  return {
    created: true,
    flow: getTaskFlowById(flow.flowId) ?? flow,
    found: true,
    task,
  };
}

export function runTaskInFlowForOwner(params: {
  flowId: string;
  callerOwnerKey: string;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  status?: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
}): RunTaskInFlowResult {
  const flow = getTaskFlowByIdForOwner({
    callerOwnerKey: params.callerOwnerKey,
    flowId: params.flowId,
  });
  if (!flow) {
    return {
      created: false,
      found: false,
      reason: "Flow not found.",
    };
  }
  return runTaskInFlow({
    agentId: params.agentId,
    childSessionKey: params.childSessionKey,
    deliveryStatus: params.deliveryStatus,
    flowId: flow.flowId,
    label: params.label,
    lastEventAt: params.lastEventAt,
    notifyPolicy: params.notifyPolicy,
    parentTaskId: params.parentTaskId,
    preferMetadata: params.preferMetadata,
    progressSummary: params.progressSummary,
    runId: params.runId,
    runtime: params.runtime,
    sourceId: params.sourceId,
    startedAt: params.startedAt,
    status: params.status,
    task: params.task,
  });
}

export async function cancelFlowById(params: {
  cfg: OpenClawConfig;
  flowId: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      cancelled: false,
      found: false,
      reason: "Flow not found.",
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      cancelled: false,
      flow,
      found: true,
      reason: `Flow is already ${flow.status}.`,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const cancelRequestedFlow = markFlowCancelRequested(flow);
  if ("reason" in cancelRequestedFlow) {
    return {
      cancelled: false,
      flow: cancelRequestedFlow.flow,
      found: true,
      reason: cancelRequestedFlow.reason,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const linkedTasks = listTasksForFlowId(flow.flowId);
  const activeTasks = linkedTasks.filter((task) => isActiveTaskStatus(task.status));
  for (const task of activeTasks) {
    await cancelTaskById({
      cfg: params.cfg,
      taskId: task.taskId,
    });
  }
  const refreshedTasks = listTasksForFlowId(flow.flowId);
  const remainingActive = refreshedTasks.filter((task) => isActiveTaskStatus(task.status));
  if (remainingActive.length > 0) {
    return {
      cancelled: false,
      flow: getTaskFlowById(flow.flowId) ?? cancelRequestedFlow,
      found: true,
      reason: "One or more child tasks are still active.",
      tasks: refreshedTasks,
    };
  }
  const now = Date.now();
  const refreshedFlow = getTaskFlowById(flow.flowId) ?? cancelRequestedFlow;
  if (isTerminalFlowStatus(refreshedFlow.status)) {
    return {
      cancelled: refreshedFlow.status === "cancelled",
      flow: refreshedFlow,
      found: true,
      reason:
        refreshedFlow.status === "cancelled"
          ? undefined
          : `Flow is already ${refreshedFlow.status}.`,
      tasks: refreshedTasks,
    };
  }
  const updatedFlow = cancelManagedFlowAfterChildrenSettle(refreshedFlow, now);
  if ("reason" in updatedFlow) {
    return {
      cancelled: false,
      flow: updatedFlow.flow,
      found: true,
      reason: updatedFlow.reason,
      tasks: refreshedTasks,
    };
  }
  return {
    cancelled: true,
    flow: updatedFlow,
    found: true,
    tasks: refreshedTasks,
  };
}

export async function cancelFlowByIdForOwner(params: {
  cfg: OpenClawConfig;
  flowId: string;
  callerOwnerKey: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowByIdForOwner({
    callerOwnerKey: params.callerOwnerKey,
    flowId: params.flowId,
  });
  if (!flow) {
    return {
      cancelled: false,
      found: false,
      reason: "Flow not found.",
    };
  }
  return cancelFlowById({
    cfg: params.cfg,
    flowId: flow.flowId,
  });
}

export async function cancelDetachedTaskRunById(params: { cfg: OpenClawConfig; taskId: string }) {
  return cancelTaskById(params);
}
