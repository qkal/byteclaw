import type { OpenClawConfig } from "../../config/config.js";
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  runTaskInFlowForOwner,
} from "../../tasks/task-executor.js";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import type { JsonValue, TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  type TaskFlowUpdateResult,
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  requestFlowCancel,
  resumeFlow,
  setFlowWaiting,
} from "../../tasks/task-flow-runtime-internal.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
} from "../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import type { OpenClawPluginToolContext } from "../types.js";

export type ManagedTaskFlowRecord = TaskFlowRecord & {
  syncMode: "managed";
  controllerId: string;
};

export type ManagedTaskFlowMutationErrorCode = "not_found" | "not_managed" | "revision_conflict";

export type ManagedTaskFlowMutationResult =
  | {
      applied: true;
      flow: ManagedTaskFlowRecord;
    }
  | {
      applied: false;
      code: ManagedTaskFlowMutationErrorCode;
      current?: TaskFlowRecord;
    };

export type BoundTaskFlowTaskRunResult =
  | {
      created: true;
      flow: ManagedTaskFlowRecord;
      task: TaskRecord;
    }
  | {
      created: false;
      reason: string;
      found: boolean;
      flow?: TaskFlowRecord;
    };

export type BoundTaskFlowCancelResult = Awaited<ReturnType<typeof cancelFlowByIdForOwner>>;

export interface BoundTaskFlowRuntime {
  readonly sessionKey: string;
  readonly requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  createManaged: (params: {
    controllerId: string;
    goal: string;
    status?: ManagedTaskFlowRecord["status"];
    notifyPolicy?: TaskNotifyPolicy;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    cancelRequestedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    endedAt?: number | null;
  }) => ManagedTaskFlowRecord;
  get: (flowId: string) => TaskFlowRecord | undefined;
  list: () => TaskFlowRecord[];
  findLatest: () => TaskFlowRecord | undefined;
  resolve: (token: string) => TaskFlowRecord | undefined;
  getTaskSummary: (flowId: string) => TaskRegistrySummary | undefined;
  setWaiting: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    waitJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  resume: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowRecord["status"], "queued" | "running">;
    currentStep?: string | null;
    stateJson?: JsonValue | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
    blockedTaskId?: string | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  requestCancel: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  cancel: (params: { flowId: string; cfg: OpenClawConfig }) => Promise<BoundTaskFlowCancelResult>;
  runTask: (params: {
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
  }) => BoundTaskFlowTaskRunResult;
}

export interface PluginRuntimeTaskFlow {
  bindSession: (params: {
    sessionKey: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  }) => BoundTaskFlowRuntime;
  fromToolContext: (
    ctx: Pick<OpenClawPluginToolContext, "sessionKey" | "deliveryContext">,
  ) => BoundTaskFlowRuntime;
}

function assertSessionKey(sessionKey: string | undefined, errorMessage: string): string {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function asManagedTaskFlowRecord(
  flow: TaskFlowRecord | undefined,
): ManagedTaskFlowRecord | undefined {
  if (!flow || flow.syncMode !== "managed" || !flow.controllerId) {
    return undefined;
  }
  return flow as ManagedTaskFlowRecord;
}

function resolveManagedFlowForOwner(params: {
  flowId: string;
  ownerKey: string;
}):
  | { ok: true; flow: ManagedTaskFlowRecord }
  | { ok: false; code: "not_found" | "not_managed"; current?: TaskFlowRecord } {
  const flow = getTaskFlowByIdForOwner({
    callerOwnerKey: params.ownerKey,
    flowId: params.flowId,
  });
  if (!flow) {
    return { code: "not_found", ok: false };
  }
  const managed = asManagedTaskFlowRecord(flow);
  if (!managed) {
    return { code: "not_managed", current: flow, ok: false };
  }
  return { flow: managed, ok: true };
}

function mapFlowUpdateResult(result: TaskFlowUpdateResult): ManagedTaskFlowMutationResult {
  if (result.applied) {
    const managed = asManagedTaskFlowRecord(result.flow);
    if (!managed) {
      return {
        applied: false,
        code: "not_managed",
        current: result.flow,
      };
    }
    return {
      applied: true,
      flow: managed,
    };
  }
  return {
    applied: false,
    code: result.reason,
    ...(result.current ? { current: result.current } : {}),
  };
}

function createBoundTaskFlowRuntime(params: {
  sessionKey: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): BoundTaskFlowRuntime {
  const ownerKey = assertSessionKey(
    params.sessionKey,
    "TaskFlow runtime requires a bound sessionKey.",
  );
  const requesterOrigin = params.requesterOrigin
    ? normalizeDeliveryContext(params.requesterOrigin)
    : undefined;

  return {
    sessionKey: ownerKey,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    createManaged: (input) =>
      createManagedTaskFlow({
        cancelRequestedAt: input.cancelRequestedAt,
        controllerId: input.controllerId,
        createdAt: input.createdAt,
        currentStep: input.currentStep,
        endedAt: input.endedAt,
        goal: input.goal,
        notifyPolicy: input.notifyPolicy,
        ownerKey,
        requesterOrigin,
        stateJson: input.stateJson,
        status: input.status,
        updatedAt: input.updatedAt,
        waitJson: input.waitJson,
      }) as ManagedTaskFlowRecord,
    get: (flowId) =>
      getTaskFlowByIdForOwner({
        callerOwnerKey: ownerKey,
        flowId,
      }),
    list: () =>
      listTaskFlowsForOwner({
        callerOwnerKey: ownerKey,
      }),
    findLatest: () =>
      findLatestTaskFlowForOwner({
        callerOwnerKey: ownerKey,
      }),
    resolve: (token) =>
      resolveTaskFlowForLookupTokenForOwner({
        callerOwnerKey: ownerKey,
        token,
      }),
    getTaskSummary: (flowId) => {
      const flow = getTaskFlowByIdForOwner({
        callerOwnerKey: ownerKey,
        flowId,
      });
      return flow ? getFlowTaskSummary(flow.flowId) : undefined;
    },
    setWaiting: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        setFlowWaiting({
          blockedSummary: input.blockedSummary,
          blockedTaskId: input.blockedTaskId,
          currentStep: input.currentStep,
          expectedRevision: input.expectedRevision,
          flowId: flow.flow.flowId,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
          waitJson: input.waitJson,
        }),
      );
    },
    resume: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        resumeFlow({
          currentStep: input.currentStep,
          expectedRevision: input.expectedRevision,
          flowId: flow.flow.flowId,
          stateJson: input.stateJson,
          status: input.status,
          updatedAt: input.updatedAt,
        }),
      );
    },
    finish: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        finishFlow({
          endedAt: input.endedAt,
          expectedRevision: input.expectedRevision,
          flowId: flow.flow.flowId,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
        }),
      );
    },
    fail: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        failFlow({
          blockedSummary: input.blockedSummary,
          blockedTaskId: input.blockedTaskId,
          endedAt: input.endedAt,
          expectedRevision: input.expectedRevision,
          flowId: flow.flow.flowId,
          stateJson: input.stateJson,
          updatedAt: input.updatedAt,
        }),
      );
    },
    requestCancel: (input) => {
      const flow = resolveManagedFlowForOwner({
        flowId: input.flowId,
        ownerKey,
      });
      if (!flow.ok) {
        return {
          applied: false,
          code: flow.code,
          ...(flow.current ? { current: flow.current } : {}),
        };
      }
      return mapFlowUpdateResult(
        requestFlowCancel({
          cancelRequestedAt: input.cancelRequestedAt,
          expectedRevision: input.expectedRevision,
          flowId: flow.flow.flowId,
        }),
      );
    },
    cancel: ({ flowId, cfg }) =>
      cancelFlowByIdForOwner({
        callerOwnerKey: ownerKey,
        cfg,
        flowId,
      }),
    runTask: (input) => {
      const created = runTaskInFlowForOwner({
        agentId: input.agentId,
        callerOwnerKey: ownerKey,
        childSessionKey: input.childSessionKey,
        deliveryStatus: input.deliveryStatus,
        flowId: input.flowId,
        label: input.label,
        lastEventAt: input.lastEventAt,
        notifyPolicy: input.notifyPolicy,
        parentTaskId: input.parentTaskId,
        preferMetadata: input.preferMetadata,
        progressSummary: input.progressSummary,
        runId: input.runId,
        runtime: input.runtime,
        sourceId: input.sourceId,
        startedAt: input.startedAt,
        status: input.status,
        task: input.task,
      });
      if (!created.created) {
        return {
          created: false,
          found: created.found,
          reason: created.reason ?? "Task was not created.",
          ...(created.flow ? { flow: created.flow } : {}),
        };
      }
      const managed = asManagedTaskFlowRecord(created.flow);
      if (!managed) {
        return {
          created: false,
          flow: created.flow,
          found: true,
          reason: "TaskFlow does not accept managed child tasks.",
        };
      }
      if (!created.task) {
        return {
          created: false,
          flow: created.flow,
          found: true,
          reason: "Task was not created.",
        };
      }
      return {
        created: true,
        flow: managed,
        task: created.task,
      };
    },
  };
}

export function createRuntimeTaskFlow(): PluginRuntimeTaskFlow {
  return {
    bindSession: (params) =>
      createBoundTaskFlowRuntime({
        requesterOrigin: params.requesterOrigin,
        sessionKey: params.sessionKey,
      }),
    fromToolContext: (ctx) =>
      createBoundTaskFlowRuntime({
        requesterOrigin: ctx.deliveryContext,
        sessionKey: assertSessionKey(
          ctx.sessionKey,
          "TaskFlow runtime requires tool context with a sessionKey.",
        ),
      }),
  };
}
