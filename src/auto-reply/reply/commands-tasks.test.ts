import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import { buildTasksReply, handleTasksCommand } from "./commands-tasks.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const baseCfg = {
  channels: { whatsapp: { allowFrom: ["*"] } },
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

async function buildTasksReplyForTest(params: { sessionKey?: string } = {}) {
  const commandParams = buildCommandTestParams("/tasks", baseCfg);
  return await buildTasksReply({
    ...commandParams,
    sessionKey: params.sessionKey ?? commandParams.sessionKey,
  });
}

function configureInMemoryTaskRegistryStoreForTests(): void {
  configureTaskRegistryRuntime({
    store: {
      close: () => {},
      deleteDeliveryState: () => {},
      deleteTask: () => {},
      deleteTaskWithDeliveryState: () => {},
      loadSnapshot: () => ({
        deliveryStates: new Map(),
        tasks: new Map(),
      }),
      saveSnapshot: () => {},
      upsertDeliveryState: () => {},
      upsertTask: () => {},
      upsertTaskWithDeliveryState: () => {},
    },
  });
}

describe("buildTasksReply", () => {
  beforeEach(() => {
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("lists active and recent tasks for the current session", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:subagent:tasks-running",
      progressSummary: "still working",
      requesterSessionKey: "agent:main:main",
      runId: "run-tasks-running",
      runtime: "subagent",
      task: "active background task",
    });
    createQueuedTaskRun({
      childSessionKey: "agent:main:subagent:tasks-queued",
      requesterSessionKey: "agent:main:main",
      runId: "run-tasks-queued",
      runtime: "cron",
      task: "queued background task",
    });
    createRunningTaskRun({
      childSessionKey: "agent:main:acp:tasks-failed",
      requesterSessionKey: "agent:main:main",
      runId: "run-tasks-failed",
      runtime: "acp",
      task: "failed background task",
    });
    failTaskRunByRunId({
      endedAt: Date.now(),
      error: "approval denied",
      runId: "run-tasks-failed",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("📋 Tasks");
    expect(reply.text).toContain("Current session: 2 active · 3 total");
    expect(reply.text).toContain("🟢 active background task");
    expect(reply.text).toContain("🟡 queued background task");
    expect(reply.text).toContain("🔴 failed background task");
    expect(reply.text).toContain("approval denied");
  });

  it("sanitizes leaked internal runtime context from visible task details", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:acp:tasks-sanitized-failed",
      progressSummary: "still working",
      requesterSessionKey: "agent:main:main",
      runId: "run-tasks-sanitized-failed",
      runtime: "acp",
      task: "Visible failed task",
    });
    failTaskRunByRunId({
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      runId: "run-tasks-sanitized-failed",
      terminalSummary: "Needs a login refresh.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("Visible failed task");
    expect(reply.text).toContain("Needs a login refresh.");
    expect(reply.text).not.toContain("OpenClaw runtime context (internal):");
    expect(reply.text).not.toContain("Internal task completion event");
  });

  it("sanitizes inline internal runtime fences from visible task titles", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:main",
      progressSummary: "done",
      requesterSessionKey: "agent:main:main",
      runId: "run-tasks-inline-fence",
      runtime: "cli",
      task: [
        "[Mon 2026-04-06 02:42 GMT+1] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
      ].join("\n"),
    });
    completeTaskRunByRunId({
      endedAt: Date.now(),
      runId: "run-tasks-inline-fence",
      terminalSummary: "Finished.",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("[Mon 2026-04-06 02:42 GMT+1]");
    expect(reply.text).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
    expect(reply.text).not.toContain("OpenClaw runtime context (internal):");
  });

  it("hides stale completed tasks from the task board", async () => {
    createQueuedTaskRun({
      childSessionKey: "agent:main:subagent:tasks-stale",
      requesterSessionKey: "agent:main:main",
      runId: "run-tasks-stale",
      runtime: "cron",
      task: "stale completed task",
    });
    completeTaskRunByRunId({
      endedAt: Date.now() - 10 * 60_000,
      runId: "run-tasks-stale",
      terminalSummary: "done a while ago",
    });

    const reply = await buildTasksReplyForTest();

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).not.toContain("stale completed task");
    expect(reply.text).not.toContain("done a while ago");
  });

  it("falls back to agent-local counts when the current session has no visible tasks", async () => {
    createRunningTaskRun({
      agentId: "main",
      childSessionKey: "agent:main:subagent:tasks-agent-fallback",
      progressSummary: "hidden progress detail",
      requesterSessionKey: "agent:main:other-session",
      runId: "run-tasks-agent-fallback",
      runtime: "subagent",
      task: "hidden background task",
    });

    const reply = await buildTasksReplyForTest({
      sessionKey: "agent:main:empty-session",
    });

    expect(reply.text).toContain("All clear - nothing linked to this session right now.");
    expect(reply.text).toContain("Agent-local: 1 active · 1 total");
    expect(reply.text).not.toContain("hidden background task");
    expect(reply.text).not.toContain("hidden progress detail");
  });
});

describe("handleTasksCommand", () => {
  it("returns usage for unsupported args", async () => {
    const params = buildCommandTestParams("/tasks extra", baseCfg);

    const result = await handleTasksCommand(params, true);

    expect(result).toEqual({
      reply: { text: "Usage: /tasks" },
      shouldContinue: false,
    });
  });
});
