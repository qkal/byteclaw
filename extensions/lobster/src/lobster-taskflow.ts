import type { OpenClawPluginApi } from "../runtime-api.js";
import type { LobsterEnvelope, LobsterRunner, LobsterRunnerParams } from "./lobster-runner.js";

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["taskFlow"]["bindSession"]
>;

type FlowRecord = ReturnType<BoundTaskFlow["createManaged"]>;
type MutationResult = ReturnType<BoundTaskFlow["setWaiting"]>;

export interface LobsterApprovalWaitState {
  kind: "lobster_approval";
  prompt: string;
  items: JsonLike[];
  resumeToken?: string;
}

export interface RunManagedLobsterFlowParams {
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams;
  controllerId: string;
  goal: string;
  stateJson?: JsonLike;
  currentStep?: string;
  waitingStep?: string;
}

export interface ResumeManagedLobsterFlowParams {
  taskFlow: BoundTaskFlow;
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams & {
    action: "resume";
    token: string;
    approve: boolean;
  };
  flowId: string;
  expectedRevision: number;
  currentStep?: string;
  waitingStep?: string;
}

export type ManagedLobsterFlowResult =
  | {
      ok: true;
      envelope: LobsterEnvelope;
      flow: FlowRecord;
      mutation: MutationResult;
    }
  | {
      ok: false;
      flow?: FlowRecord;
      mutation?: MutationResult;
      error: Error;
    };

function toJsonLike(value: unknown, seen = new WeakSet<object>()): JsonLike {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "boolean":
    case "string": {
      return value;
    }
    case "number": {
      return Number.isFinite(value) ? value : String(value);
    }
    case "bigint": {
      return value.toString();
    }
    case "undefined":
    case "function":
    case "symbol": {
      return null;
    }
    case "object": {
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (Array.isArray(value)) {
        return value.map((item) => toJsonLike(item, seen));
      }
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      const jsonObject: Record<string, JsonLike> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          continue;
        }
        jsonObject[key] = toJsonLike(entry, seen);
      }
      seen.delete(value);
      return jsonObject;
    }
  }
  return null;
}

function buildApprovalWaitState(envelope: Extract<LobsterEnvelope, { ok: true }>): JsonLike {
  if (!envelope.requiresApproval) {
    return {
      items: [],
      kind: "lobster_approval",
      prompt: "",
    } satisfies LobsterApprovalWaitState;
  }
  return {
    items: envelope.requiresApproval.items.map((item) => toJsonLike(item)),
    kind: "lobster_approval",
    prompt: envelope.requiresApproval.prompt,
    ...(envelope.requiresApproval.resumeToken
      ? { resumeToken: envelope.requiresApproval.resumeToken }
      : {}),
  } satisfies LobsterApprovalWaitState;
}

function applyEnvelopeToFlow(params: {
  taskFlow: BoundTaskFlow;
  flow: FlowRecord;
  envelope: LobsterEnvelope;
  waitingStep: string;
}): MutationResult {
  const { taskFlow, flow, envelope, waitingStep } = params;

  if (!envelope.ok) {
    return taskFlow.fail({
      expectedRevision: flow.revision,
      flowId: flow.flowId,
    });
  }

  if (envelope.status === "needs_approval") {
    return taskFlow.setWaiting({
      currentStep: waitingStep,
      expectedRevision: flow.revision,
      flowId: flow.flowId,
      waitJson: buildApprovalWaitState(envelope),
    });
  }

  return taskFlow.finish({
    expectedRevision: flow.revision,
    flowId: flow.flowId,
  });
}

function buildEnvelopeError(envelope: Extract<LobsterEnvelope, { ok: false }>) {
  return new Error(envelope.error.message);
}

export async function runManagedLobsterFlow(
  params: RunManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const flow = params.taskFlow.createManaged({
    controllerId: params.controllerId,
    currentStep: params.currentStep ?? "run_lobster",
    goal: params.goal,
    ...(params.stateJson !== undefined ? { stateJson: params.stateJson } : {}),
  });

  try {
    const envelope = await params.runner.run(params.runnerParams);
    const mutation = applyEnvelopeToFlow({
      envelope,
      flow,
      taskFlow: params.taskFlow,
      waitingStep: params.waitingStep ?? "await_lobster_approval",
    });
    if (!envelope.ok) {
      return {
        error: buildEnvelopeError(envelope),
        flow,
        mutation,
        ok: false,
      };
    }
    return {
      envelope,
      flow,
      mutation,
      ok: true,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const mutation = params.taskFlow.fail({
        expectedRevision: flow.revision,
        flowId: flow.flowId,
      });
      return {
        error: err,
        flow,
        mutation,
        ok: false,
      };
    } catch {
      return {
        error: err,
        flow,
        ok: false,
      };
    }
  }
}

export async function resumeManagedLobsterFlow(
  params: ResumeManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const resumed = params.taskFlow.resume({
    currentStep: params.currentStep ?? "resume_lobster",
    expectedRevision: params.expectedRevision,
    flowId: params.flowId,
    status: "running",
  });

  if (!resumed.applied) {
    return {
      error: new Error(`TaskFlow resume failed: ${resumed.code}`),
      mutation: resumed,
      ok: false,
    };
  }

  try {
    const envelope = await params.runner.run(params.runnerParams);
    const mutation = applyEnvelopeToFlow({
      envelope,
      flow: resumed.flow,
      taskFlow: params.taskFlow,
      waitingStep: params.waitingStep ?? "await_lobster_approval",
    });
    if (!envelope.ok) {
      return {
        error: buildEnvelopeError(envelope),
        flow: resumed.flow,
        mutation,
        ok: false,
      };
    }
    return {
      envelope,
      flow: resumed.flow,
      mutation,
      ok: true,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const mutation = params.taskFlow.fail({
        expectedRevision: resumed.flow.revision,
        flowId: params.flowId,
      });
      return {
        error: err,
        flow: resumed.flow,
        mutation,
        ok: false,
      };
    } catch {
      return {
        error: err,
        flow: resumed.flow,
        ok: false,
      };
    }
  }
}
