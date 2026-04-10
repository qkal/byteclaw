import type { JsonValue } from "../../tasks/task-flow-registry.types.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRuntime,
  TaskRuntimeCounts,
  TaskScopeKind,
  TaskStatus,
  TaskStatusCounts,
  TaskTerminalOutcome,
} from "../../tasks/task-registry.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";

export interface TaskRunAggregateSummary {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
}

export interface TaskRunView {
  id: string;
  runtime: TaskRuntime;
  sourceId?: string;
  sessionKey: string;
  ownerKey: string;
  scope: TaskScopeKind;
  childSessionKey?: string;
  flowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  title: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
}

export type TaskRunDetail = TaskRunView;

export interface TaskRunCancelResult {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskRunDetail;
}

export interface TaskFlowView {
  id: string;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  status: import("../../tasks/task-flow-registry.types.js").TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export type TaskFlowDetail = TaskFlowView & {
  state?: JsonValue;
  wait?: JsonValue;
  blocked?: {
    taskId?: string;
    summary?: string;
  };
  tasks: TaskRunView[];
  taskSummary: TaskRunAggregateSummary;
};
