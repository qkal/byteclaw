import { describe, expect, it } from "vitest";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  isTerminalTaskStatus,
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
} from "./task-executor-policy.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";

function createTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    createdAt: partial.createdAt ?? 1,
    deliveryStatus: partial.deliveryStatus ?? "pending",
    notifyPolicy: partial.notifyPolicy ?? "done_only",
    ownerKey: partial.ownerKey ?? partial.requesterSessionKey ?? "agent:main:main",
    requesterSessionKey: partial.requesterSessionKey ?? partial.ownerKey ?? "agent:main:main",
    runtime: partial.runtime ?? "acp",
    scopeKind: partial.scopeKind ?? "session",
    status: partial.status ?? "running",
    task: partial.task ?? "Investigate issue",
    taskId: partial.taskId ?? "task-1",
    ...partial,
  };
}

describe("task-executor-policy", () => {
  it("identifies terminal statuses", () => {
    expect(isTerminalTaskStatus("queued")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("succeeded")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("timed_out")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("lost")).toBe(true);
  });

  it("formats terminal, followup, and progress messages", () => {
    const blockedTask = createTask({
      label: "ACP import",
      runId: "run-1234567890",
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: "Needs login.",
    });
    const progressEvent: TaskEventRecord = {
      at: 10,
      kind: "progress",
      summary: "No output for 60s.",
    };

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: ACP import (run run-1234). Needs login.",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: ACP import (run run-1234). Needs login.",
    );
    expect(formatTaskStateChangeMessage(blockedTask, progressEvent)).toBe(
      "Background task update: ACP import. No output for 60s.",
    );
  });

  it("sanitizes leaked internal runtime context from terminal and progress copy", () => {
    const leaked = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
    ].join("\n");
    const blockedTask = createTask({
      label: leaked,
      runId: "run-1234567890",
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: leaked,
    });
    const failedTask = createTask({
      error: leaked,
      label: leaked,
      runId: "run-2234567890",
      status: "failed",
      terminalSummary: "Needs manual approval.",
    });
    const progressEvent: TaskEventRecord = {
      at: 10,
      kind: "progress",
      summary: leaked,
    };

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: Background task (run run-1234).",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: Background task (run run-1234). Task is blocked and needs follow-up.",
    );
    expect(formatTaskTerminalMessage(failedTask)).toBe(
      "Background task failed: Background task (run run-2234). Needs manual approval.",
    );
    expect(formatTaskStateChangeMessage(blockedTask, progressEvent)).toBeNull();
  });

  it("redacts raw exec denial text from blocked task updates", () => {
    const blockedTask = createTask({
      label: "ACP import",
      runId: "run-1234567890",
      status: "succeeded",
      terminalOutcome: "blocked",
      terminalSummary: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
    });

    expect(formatTaskTerminalMessage(blockedTask)).toBe(
      "Background task blocked: ACP import (run run-1234). Command did not run: approval timed out.",
    );
    expect(formatTaskBlockedFollowupMessage(blockedTask)).toBe(
      "Task needs follow-up: ACP import (run run-1234). Command did not run: approval timed out.",
    );
  });

  it("keeps delivery policy decisions explicit", () => {
    expect(
      shouldAutoDeliverTaskTerminalUpdate(
        createTask({
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          status: "succeeded",
        }),
      ),
    ).toBe(true);
    expect(
      shouldAutoDeliverTaskTerminalUpdate(
        createTask({
          deliveryStatus: "pending",
          runtime: "subagent",
          status: "succeeded",
        }),
      ),
    ).toBe(false);
    expect(
      shouldAutoDeliverTaskStateChange(
        createTask({
          deliveryStatus: "pending",
          notifyPolicy: "state_changes",
          status: "running",
        }),
      ),
    ).toBe(true);
    expect(
      shouldAutoDeliverTaskStateChange(
        createTask({
          deliveryStatus: "pending",
          notifyPolicy: "state_changes",
          status: "failed",
        }),
      ),
    ).toBe(false);
    expect(
      shouldSuppressDuplicateTerminalDelivery({
        preferredTaskId: "task-2",
        task: createTask({
          runId: "run-duplicate",
          runtime: "acp",
        }),
      }),
    ).toBe(true);
    expect(
      shouldSuppressDuplicateTerminalDelivery({
        preferredTaskId: "task-1",
        task: createTask({
          runId: "run-duplicate",
          runtime: "acp",
        }),
      }),
    ).toBe(false);
    expect(
      shouldSuppressDuplicateTerminalDelivery({
        preferredTaskId: undefined,
        task: createTask({
          runId: "run-duplicate",
          runtime: "acp",
        }),
      }),
    ).toBe(false);
  });
});
