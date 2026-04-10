import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import { buildStatusReply, buildStatusText } from "./commands-status.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const baseCfg = {
  channels: { whatsapp: { allowFrom: ["*"] } },
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

async function buildStatusReplyForTest(params: { sessionKey?: string; verbose?: boolean }) {
  const commandParams = buildCommandTestParams("/status", baseCfg);
  const sessionKey = params.sessionKey ?? commandParams.sessionKey;
  return await buildStatusReply({
    activeModelAuthOverride: "api-key",
    cfg: baseCfg,
    command: commandParams.command,
    contextTokens: 0,
    defaultGroupActivation: commandParams.defaultGroupActivation,
    isGroup: commandParams.isGroup,
    model: "claude-opus-4-6",
    modelAuthOverride: "api-key",
    parentSessionKey: sessionKey,
    provider: "anthropic",
    resolveDefaultThinkingLevel: commandParams.resolveDefaultThinkingLevel,
    resolvedElevatedLevel: commandParams.resolvedElevatedLevel,
    resolvedFastMode: false,
    resolvedReasoningLevel: commandParams.resolvedReasoningLevel,
    resolvedThinkLevel: commandParams.resolvedThinkLevel,
    resolvedVerboseLevel: params.verbose ? "on" : commandParams.resolvedVerboseLevel,
    sessionEntry: commandParams.sessionEntry,
    sessionKey,
    sessionScope: commandParams.sessionScope,
    storePath: commandParams.storePath,
  });
}

function writeTranscriptUsageLog(params: {
  dir: string;
  agentId: string;
  sessionId: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
}) {
  const logPath = path.join(
    params.dir,
    ".openclaw",
    "agents",
    params.agentId,
    "sessions",
    `${params.sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify({
      message: {
        model: "claude-opus-4-5",
        role: "assistant",
        usage: params.usage,
      },
      type: "message",
    }),
    "utf8",
  );
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

describe("buildStatusReply subagent summary", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
    resetTaskRegistryForTests({ persist: false });
  });

  it("counts ended orchestrators with active descendants as active", async () => {
    const parentKey = "agent:main:subagent:status-ended-parent";
    addSubagentRunForTests({
      childSessionKey: parentKey,
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-ended-parent",
      startedAt: Date.now() - 120_000,
      task: "status orchestrator",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:status-ended-parent:subagent:child",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      requesterDisplayKey: "subagent:status-ended-parent",
      requesterSessionKey: parentKey,
      runId: "run-status-active-child",
      startedAt: Date.now() - 60_000,
      task: "status child still running",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("dedupes stale rows in the verbose subagent status summary", async () => {
    const childSessionKey = "agent:main:subagent:status-dedupe-worker";
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-current",
      startedAt: Date.now() - 60_000,
      task: "current status worker",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      endedAt: Date.now() - 90_000,
      outcome: { status: "ok" },
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-stale",
      startedAt: Date.now() - 120_000,
      task: "stale status worker",
    });

    const reply = await buildStatusReplyForTest({ verbose: true });

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("· 1 done");
  });

  it("does not count a child session that moved to a newer parent in the old parent's status", async () => {
    const oldParentKey = "agent:main:subagent:status-old-parent";
    const newParentKey = "agent:main:subagent:status-new-parent";
    const childSessionKey = "agent:main:subagent:status-shared-child";
    addSubagentRunForTests({
      childSessionKey: oldParentKey,
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-old-parent",
      startedAt: Date.now() - 120_000,
      task: "old parent",
    });
    addSubagentRunForTests({
      childSessionKey: newParentKey,
      cleanup: "keep",
      createdAt: Date.now() - 90_000,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-new-parent",
      startedAt: Date.now() - 90_000,
      task: "new parent",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: oldParentKey,
      createdAt: Date.now() - 60_000,
      requesterDisplayKey: oldParentKey,
      requesterSessionKey: oldParentKey,
      runId: "run-status-child-stale-old-parent",
      startedAt: Date.now() - 60_000,
      task: "stale old parent child",
    });
    addSubagentRunForTests({
      childSessionKey,
      cleanup: "keep",
      controllerSessionKey: newParentKey,
      createdAt: Date.now() - 30_000,
      requesterDisplayKey: newParentKey,
      requesterSessionKey: newParentKey,
      runId: "run-status-child-current-new-parent",
      startedAt: Date.now() - 30_000,
      task: "current new parent child",
    });

    const reply = await buildStatusReplyForTest({ sessionKey: oldParentKey, verbose: true });

    expect(reply?.text).not.toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("stale old parent child");
  });

  it("counts controller-owned runs even when the latest child requester differs", async () => {
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:status-controller-owned",
      cleanup: "keep",
      controllerSessionKey: "agent:main:main",
      createdAt: Date.now() - 60_000,
      requesterDisplayKey: "requester-only",
      requesterSessionKey: "agent:main:requester-only",
      runId: "run-status-controller-owned",
      startedAt: Date.now() - 60_000,
      task: "controller-owned status worker",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("includes active and total task counts for the current session", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:subagent:status-task-running",
      progressSummary: "still working",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-running",
      runtime: "subagent",
      task: "active background task",
    });
    createQueuedTaskRun({
      childSessionKey: "agent:main:subagent:status-task-queued",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-queued",
      runtime: "cron",
      task: "queued background task",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 2 active · 2 total");
    expect(reply?.text).toMatch(/📌 Tasks: 2 active · 2 total · (subagent|cron) · /);
  });

  it("hides stale completed task rows from the session task line", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:subagent:status-task-live",
      progressSummary: "still working",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-live",
      runtime: "subagent",
      task: "live background task",
    });
    createQueuedTaskRun({
      childSessionKey: "agent:main:subagent:status-task-stale-done",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-stale-done",
      runtime: "cron",
      task: "stale completed task",
    });
    completeTaskRunByRunId({
      endedAt: Date.now() - 10 * 60_000,
      runId: "run-status-task-stale-done",
      terminalSummary: "done a while ago",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 active · 1 total");
    expect(reply?.text).toContain("live background task");
    expect(reply?.text).not.toContain("stale completed task");
    expect(reply?.text).not.toContain("done a while ago");
  });

  it("shows a recent failure when no active tasks remain", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:acp:status-task-failed",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-failed",
      runtime: "acp",
      task: "failed background task",
    });
    failTaskRunByRunId({
      endedAt: Date.now(),
      error: "approval denied",
      runId: "run-status-task-failed",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("failed background task");
    expect(reply?.text).toContain("approval denied");
  });

  it("does not leak internal runtime context through the task status line", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:subagent:status-task-leak",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-leak",
      runtime: "subagent",
      task: "leaked context task",
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
      runId: "run-status-task-leak",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("leaked context task");
    expect(reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(reply?.text).not.toContain("Internal task completion event");
  });

  it("truncates long task titles and details in the session task line", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:subagent:status-task-truncated",
      progressSummary:
        "This progress detail is also intentionally long so the status surface proves it truncates verbose task context instead of dumping a multi-sentence internal update into the reply output.",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-truncated",
      runtime: "subagent",
      task: "This is a deliberately long task prompt that should never be emitted in full by /status because it can include internal instructions and file paths that are not appropriate for the headline line shown to users.",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain(
      "This is a deliberately long task prompt that should never be emitted in full by…",
    );
    expect(reply?.text).toContain(
      "This progress detail is also intentionally long so the status surface proves it truncates verbose task context instead…",
    );
    expect(reply?.text).not.toContain("internal instructions and file paths");
    expect(reply?.text).not.toContain("dumping a multi-sentence internal update");
  });

  it("prefers failure context over newer success context when showing recent failures", async () => {
    createRunningTaskRun({
      childSessionKey: "agent:main:acp:status-task-failed-priority",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-failed-priority",
      runtime: "acp",
      task: "failed background task",
    });
    failTaskRunByRunId({
      endedAt: Date.now() - 30_000,
      error: "approval denied",
      runId: "run-status-task-failed-priority",
    });
    createRunningTaskRun({
      childSessionKey: "agent:main:subagent:status-task-succeeded-later",
      requesterSessionKey: "agent:main:main",
      runId: "run-status-task-succeeded-later",
      runtime: "subagent",
      task: "later successful task",
    });
    completeTaskRunByRunId({
      endedAt: Date.now(),
      runId: "run-status-task-succeeded-later",
      terminalSummary: "all done",
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("📌 Tasks: 1 recent failure");
    expect(reply?.text).toContain("failed background task");
    expect(reply?.text).toContain("approval denied");
    expect(reply?.text).not.toContain("later successful task");
    expect(reply?.text).not.toContain("all done");
  });

  it("falls back to same-agent task counts without details when the current session has none", async () => {
    createRunningTaskRun({
      agentId: "main",
      childSessionKey: "agent:main:subagent:status-agent-fallback-running",
      progressSummary: "hidden progress detail",
      requesterSessionKey: "agent:main:other",
      runId: "run-status-agent-fallback-running",
      runtime: "subagent",
      task: "hidden task title",
    });
    createQueuedTaskRun({
      agentId: "main",
      childSessionKey: "agent:main:subagent:status-agent-fallback-queued",
      requesterSessionKey: "agent:main:another",
      runId: "run-status-agent-fallback-queued",
      runtime: "cron",
      task: "another hidden task title",
    });

    const reply = await buildStatusReplyForTest({ sessionKey: "agent:main:empty-session" });

    expect(reply?.text).toContain("📌 Tasks: 2 active · 2 total · agent-local");
    expect(reply?.text).not.toContain("hidden task title");
    expect(reply?.text).not.toContain("hidden progress detail");
    expect(reply?.text).not.toContain("subagent");
    expect(reply?.text).not.toContain("cron");
  });

  it("uses transcript usage fallback in /status output", async () => {
    await withTempHome(async (dir) => {
      const sessionId = "sess-status-transcript";
      writeTranscriptUsageLog({
        agentId: "main",
        dir,
        sessionId,
        usage: {
          cacheRead: 1000,
          cacheWrite: 0,
          input: 1,
          output: 2,
          totalTokens: 1003,
        },
      });

      const text = await buildStatusText({
        activeModelAuthOverride: "api-key",
        cfg: baseCfg,
        contextTokens: 32_000,
        defaultGroupActivation: () => "mention",
        isGroup: false,
        model: "claude-opus-4-5",
        modelAuthOverride: "api-key",
        parentSessionKey: "agent:main:main",
        provider: "anthropic",
        resolveDefaultThinkingLevel: async () => undefined,
        resolvedFastMode: false,
        resolvedReasoningLevel: "off",
        resolvedVerboseLevel: "off",
        sessionEntry: {
          contextTokens: 32_000,
          sessionId,
          totalTokens: 3,
          updatedAt: 0,
        },
        sessionKey: "agent:main:main",
        sessionScope: "per-sender",
        statusChannel: "whatsapp",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });
});
