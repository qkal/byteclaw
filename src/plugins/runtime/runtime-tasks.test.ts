import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRuntimeTaskMocks,
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTaskFlows, createRuntimeTaskRuns } from "./runtime-tasks.js";

const runtimeTaskMocks = getRuntimeTaskMocks();

afterEach(() => {
  resetRuntimeTaskTestState();
});

describe("runtime tasks", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  it("exposes canonical task and TaskFlow DTOs without leaking raw registry fields", () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
      sessionKey: "agent:main:main",
    });
    const taskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:other",
    });
    const otherTaskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      currentStep: "triage",
      goal: "Review inbox",
      stateJson: { lane: "priority" },
    });
    const child = legacyTaskFlow.runTask({
      childSessionKey: "agent:main:subagent:child",
      flowId: created.flowId,
      label: "Inbox triage",
      lastEventAt: 11,
      progressSummary: "Inspecting",
      runId: "runtime-task-run",
      runtime: "acp",
      startedAt: 10,
      status: "running",
      task: "Review PR 1",
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    expect(taskFlows.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentStep: "triage",
          goal: "Review inbox",
          id: created.flowId,
          ownerKey: "agent:main:main",
        }),
      ]),
    );
    expect(taskFlows.get(created.flowId)).toMatchObject({
      currentStep: "triage",
      goal: "Review inbox",
      id: created.flowId,
      ownerKey: "agent:main:main",
      state: { lane: "priority" },
      taskSummary: {
        active: 1,
        total: 1,
      },
      tasks: [
        expect.objectContaining({
          flowId: created.flowId,
          id: child.task.taskId,
          label: "Inbox triage",
          runId: "runtime-task-run",
          title: "Review PR 1",
        }),
      ],
    });
    expect(taskRuns.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flowId: created.flowId,
          id: child.task.taskId,
          sessionKey: "agent:main:main",
          status: "running",
          title: "Review PR 1",
        }),
      ]),
    );
    expect(taskRuns.get(child.task.taskId)).toMatchObject({
      flowId: created.flowId,
      id: child.task.taskId,
      progressSummary: "Inspecting",
      title: "Review PR 1",
    });
    expect(taskRuns.findLatest()?.id).toBe(child.task.taskId);
    expect(taskRuns.resolve("runtime-task-run")?.id).toBe(child.task.taskId);
    expect(taskFlows.getTaskSummary(created.flowId)).toMatchObject({
      active: 1,
      total: 1,
    });

    expect(otherTaskFlows.get(created.flowId)).toBeUndefined();
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();

    const flowDetail = taskFlows.get(created.flowId);
    expect(flowDetail).not.toHaveProperty("revision");
    expect(flowDetail).not.toHaveProperty("controllerId");
    expect(flowDetail).not.toHaveProperty("syncMode");

    const taskDetail = taskRuns.get(child.task.taskId);
    expect(taskDetail).not.toHaveProperty("taskId");
    expect(taskDetail).not.toHaveProperty("requesterSessionKey");
    expect(taskDetail).not.toHaveProperty("scopeKind");
  });

  it("maps task cancellation results onto canonical task DTOs", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Cancel active task",
    });
    const child = legacyTaskFlow.runTask({
      childSessionKey: "agent:main:subagent:child",
      flowId: created.flowId,
      lastEventAt: 21,
      runId: "runtime-task-cancel",
      runtime: "acp",
      startedAt: 20,
      status: "running",
      task: "Cancel me",
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const result = await taskRuns.cancel({
      cfg: {} as never,
      taskId: child.task.taskId,
    });

    expect(runtimeTaskMocks.cancelSessionMock).toHaveBeenCalledWith({
      cfg: {},
      reason: "task-cancel",
      sessionKey: "agent:main:subagent:child",
    });
    expect(result).toMatchObject({
      cancelled: true,
      found: true,
      task: {
        id: child.task.taskId,
        status: "cancelled",
        title: "Cancel me",
      },
    });
  });

  it("does not allow cross-owner task cancellation or leak task details", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Keep owner isolation",
    });
    const child = legacyTaskFlow.runTask({
      childSessionKey: "agent:main:subagent:child",
      flowId: created.flowId,
      lastEventAt: 31,
      runId: "runtime-task-isolation",
      runtime: "acp",
      startedAt: 30,
      status: "running",
      task: "Do not cancel me",
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const result = await otherTaskRuns.cancel({
      cfg: {} as never,
      taskId: child.task.taskId,
    });

    expect(runtimeTaskMocks.cancelSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      cancelled: false,
      found: false,
      reason: "Task not found.",
    });
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();
  });
});
