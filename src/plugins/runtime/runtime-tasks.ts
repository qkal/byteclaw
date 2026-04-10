import type { OpenClawConfig } from "../../config/config.js";
import { cancelTaskById, listTasksForFlowId } from "../../tasks/runtime-internal.js";
import {
  mapTaskFlowDetail,
  mapTaskFlowView,
  mapTaskRunAggregateSummary,
  mapTaskRunDetail,
  mapTaskRunView,
} from "../../tasks/task-domain-views.js";
import { getFlowTaskSummary } from "../../tasks/task-executor.js";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import {
  findLatestTaskForRelatedSessionKeyForOwner,
  getTaskByIdForOwner,
  listTasksForRelatedSessionKeyForOwner,
  resolveTaskForLookupTokenForOwner,
} from "../../tasks/task-owner-access.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { OpenClawPluginToolContext } from "../types.js";
import type { PluginRuntimeTaskFlow } from "./runtime-taskflow.js";
import type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunView,
} from "./task-domain-types.js";

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function mapCancelledTaskResult(
  result: Awaited<ReturnType<typeof cancelTaskById>>,
): TaskRunCancelResult {
  return {
    cancelled: result.cancelled,
    found: result.found,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.task ? { task: mapTaskRunDetail(result.task) } : {}),
  };
}

export interface BoundTaskRunsRuntime {
  readonly sessionKey: string;
  readonly requesterOrigin?: ReturnType<typeof normalizeDeliveryContext>;
  get: (taskId: string) => TaskRunDetail | undefined;
  list: () => TaskRunView[];
  findLatest: () => TaskRunDetail | undefined;
  resolve: (token: string) => TaskRunDetail | undefined;
  cancel: (params: { taskId: string; cfg: OpenClawConfig }) => Promise<TaskRunCancelResult>;
}

export interface PluginRuntimeTaskRuns {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskRunsRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskRunsRuntime;
}

export interface BoundTaskFlowsRuntime {
  readonly sessionKey: string;
  readonly requesterOrigin?: ReturnType<typeof normalizeDeliveryContext>;
  get: (flowId: string) => TaskFlowDetail | undefined;
  list: () => TaskFlowView[];
  findLatest: () => TaskFlowDetail | undefined;
  resolve: (token: string) => TaskFlowDetail | undefined;
  getTaskSummary: (flowId: string) => TaskRunAggregateSummary | undefined;
}

export interface PluginRuntimeTaskFlows {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowsRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowsRuntime;
}

export interface PluginRuntimeTasks {
  runs: PluginRuntimeTaskRuns;
  flows: PluginRuntimeTaskFlows;
  /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  flow: PluginRuntimeTaskFlow;
}

function createBoundTaskRunsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): BoundTaskRunsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "Tasks runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;
  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    get: (taskId) => {
      const task = getTaskByIdForOwner({ callerOwnerKey: ownerKey, taskId });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    list: () =>
      listTasksForRelatedSessionKeyForOwner({
        callerOwnerKey: ownerKey,
        relatedSessionKey: ownerKey,
      }).map((task) => mapTaskRunView(task)),
    findLatest: () => {
      const task = findLatestTaskForRelatedSessionKeyForOwner({
        callerOwnerKey: ownerKey,
        relatedSessionKey: ownerKey,
      });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    resolve: (token) => {
      const task = resolveTaskForLookupTokenForOwner({
        callerOwnerKey: ownerKey,
        token,
      });
      return task ? mapTaskRunDetail(task) : undefined;
    },
    cancel: async ({ taskId, cfg }) => {
      const task = getTaskByIdForOwner({
        callerOwnerKey: ownerKey,
        taskId,
      });
      if (!task) {
        return {
          cancelled: false,
          found: false,
          reason: "Task not found.",
        };
      }
      return mapCancelledTaskResult(
        await cancelTaskById({
          cfg,
          taskId: task.taskId,
        }),
      );
    },
  };
}

function createBoundTaskFlowsRuntime(params: {
  sessionKey: string;
  requesterOrigin?: import("../../tasks/task-registry.types.js").TaskDeliveryState["requesterOrigin"];
}): BoundTaskFlowsRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  const getDetail = (flowId: string): TaskFlowDetail | undefined => {
    const flow = getTaskFlowByIdForOwner({
      callerOwnerKey: ownerKey,
      flowId,
    });
    if (!flow) {
      return undefined;
    }
    const tasks = listTasksForFlowId(flow.flowId);
    return mapTaskFlowDetail({
      flow,
      summary: getFlowTaskSummary(flow.flowId),
      tasks,
    });
  };

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    get: (flowId) => getDetail(flowId),
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }).map((flow) => mapTaskFlowView(flow)),
    findLatest: () => {
      const flow = findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      });
      return flow ? getDetail(flow.flowId) : undefined;
    },
    resolve: (token) => {
      const flow = resolveTaskFlowForLookupTokenForOwner({
        callerOwnerKey: ownerKey,
        token,
      });
      return flow ? getDetail(flow.flowId) : undefined;
    },
    getTaskSummary: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        callerOwnerKey: ownerKey,
        flowId,
      });
      return flow ? mapTaskRunAggregateSummary(getFlowTaskSummary(flow.flowId)) : undefined;
    },
  };
}

export function createRuntimeTaskRuns(): PluginRuntimeTaskRuns {
  return {
    bindSession: (params) =>
      createBoundTaskRunsRuntime({
        requesterOrigin: params.requesterOrigin,
        sessionKey: params.sessionKey,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskRunsRuntime({
        requesterOrigin: ctx.deliveryContext,
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "Tasks runtime requires tool context with a sessionKey.",
        ),
      }),
  };
}

export function createRuntimeTaskFlows(): PluginRuntimeTaskFlows {
  return {
    bindSession: (params) =>
      createBoundTaskFlowsRuntime({
        requesterOrigin: params.requesterOrigin,
        sessionKey: params.sessionKey,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowsRuntime({
        requesterOrigin: ctx.deliveryContext,
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
      }),
  };
}

export function createRuntimeTasks(params: {
  legacyTaskFlow: PluginRuntimeTaskFlow;
}): PluginRuntimeTasks {
  return {
    flow: params.legacyTaskFlow,
    flows: createRuntimeTaskFlows(),
    runs: createRuntimeTaskRuns(),
  };
}
