import { describe, expect, it, vi } from "vitest";
import type { LobsterRunner } from "./lobster-runner.js";
import { resumeManagedLobsterFlow, runManagedLobsterFlow } from "./lobster-taskflow.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

function expectManagedFlowFailure(
  result: Awaited<ReturnType<typeof runManagedLobsterFlow | typeof resumeManagedLobsterFlow>>,
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected managed Lobster flow to fail");
  }
  return result;
}
function createRunner(result: Awaited<ReturnType<LobsterRunner["run"]>>): LobsterRunner {
  return {
    run: vi.fn().mockResolvedValue(result),
  };
}

function createRunFlowParams(
  taskFlow: ReturnType<typeof createFakeTaskFlow>,
  runner: LobsterRunner,
): Parameters<typeof runManagedLobsterFlow>[0] {
  return {
    controllerId: "tests/lobster",
    goal: "Run Lobster workflow",
    runner,
    runnerParams: {
      action: "run",
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      pipeline: "noop",
      timeoutMs: 1000,
    },
    taskFlow,
  };
}

function createResumeFlowParams(
  taskFlow: ReturnType<typeof createFakeTaskFlow>,
  runner: LobsterRunner,
): Parameters<typeof resumeManagedLobsterFlow>[0] {
  return {
    expectedRevision: 4,
    flowId: "flow-1",
    runner,
    runnerParams: {
      action: "resume",
      approve: true,
      cwd: process.cwd(),
      maxStdoutBytes: 4096,
      timeoutMs: 1000,
      token: "resume-1",
    },
    taskFlow,
  };
}

describe("runManagedLobsterFlow", () => {
  it("creates a flow and finishes it when Lobster succeeds", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      output: [{ id: "result-1" }],
      requiresApproval: null,
      status: "ok",
    });

    const result = await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(taskFlow.createManaged).toHaveBeenCalledWith({
      controllerId: "tests/lobster",
      currentStep: "run_lobster",
      goal: "Run Lobster workflow",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      expectedRevision: 1,
      flowId: "flow-1",
    });
  });

  it("moves the flow to waiting when Lobster requests approval", async () => {
    const taskFlow = createFakeTaskFlow();
    const createdAt = new Date("2026-04-05T21:00:00.000Z");
    const runner = createRunner({
      ok: true,
      output: [],
      requiresApproval: {
        items: [{ count: 2n, createdAt, id: "item-1", skip: undefined }],
        prompt: "Approve this?",
        resumeToken: "resume-1",
        type: "approval_request",
      },
      status: "needs_approval",
    });

    const result = await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      currentStep: "await_lobster_approval",
      expectedRevision: 1,
      flowId: "flow-1",
      waitJson: {
        items: [{ count: "2", createdAt: createdAt.toISOString(), id: "item-1" }],
        kind: "lobster_approval",
        prompt: "Approve this?",
        resumeToken: "resume-1",
      },
    });
  });

  it("fails the flow when Lobster returns an error envelope", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      error: {
        message: "boom",
        type: "runtime_error",
      },
      ok: false,
    });

    const result = expectManagedFlowFailure(
      await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner)),
    );
    expect(result.error.message).toBe("boom");
    expect(taskFlow.fail).toHaveBeenCalledWith({
      expectedRevision: 1,
      flowId: "flow-1",
    });
  });

  it("fails the flow when the runner throws", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner: LobsterRunner = {
      run: vi.fn().mockRejectedValue(new Error("crashed")),
    };

    const result = expectManagedFlowFailure(
      await runManagedLobsterFlow(createRunFlowParams(taskFlow, runner)),
    );
    expect(result.error.message).toBe("crashed");
    expect(taskFlow.fail).toHaveBeenCalledWith({
      expectedRevision: 1,
      flowId: "flow-1",
    });
  });
});

describe("resumeManagedLobsterFlow", () => {
  it("resumes the flow and finishes it on success", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      output: [],
      requiresApproval: null,
      status: "ok",
    });

    const result = await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(taskFlow.resume).toHaveBeenCalledWith({
      currentStep: "resume_lobster",
      expectedRevision: 4,
      flowId: "flow-1",
      status: "running",
    });
    expect(taskFlow.finish).toHaveBeenCalledWith({
      expectedRevision: 5,
      flowId: "flow-1",
    });
  });

  it("returns a mutation error when taskFlow resume is rejected", async () => {
    const taskFlow = createFakeTaskFlow({
      resume: vi.fn().mockReturnValue({
        applied: false,
        code: "revision_conflict",
      }),
    });
    const runner = createRunner({
      ok: true,
      output: [],
      requiresApproval: null,
      status: "ok",
    });

    const result = expectManagedFlowFailure(
      await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner)),
    );
    expect(result.error.message).toMatch(/revision_conflict/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("returns to waiting when the resumed Lobster run needs approval again", async () => {
    const taskFlow = createFakeTaskFlow();
    const runner = createRunner({
      ok: true,
      output: [],
      requiresApproval: {
        items: [{ id: "item-2" }],
        prompt: "Approve this too?",
        resumeToken: "resume-2",
        type: "approval_request",
      },
      status: "needs_approval",
    });

    const result = await resumeManagedLobsterFlow(createResumeFlowParams(taskFlow, runner));

    expect(result.ok).toBe(true);
    expect(taskFlow.setWaiting).toHaveBeenCalledWith({
      currentStep: "await_lobster_approval",
      expectedRevision: 5,
      flowId: "flow-1",
      waitJson: {
        items: [{ id: "item-2" }],
        kind: "lobster_approval",
        prompt: "Approve this too?",
        resumeToken: "resume-2",
      },
    });
  });
});
