import { describe, expect, it } from "vitest";
import { listTaskAuditFindings, summarizeTaskAuditFindings } from "./task-registry.audit.js";
import type { TaskRecord } from "./task-registry.types.js";

function createTask(partial: Partial<TaskRecord>): TaskRecord {
  return {
    createdAt: partial.createdAt ?? Date.parse("2026-03-30T00:00:00.000Z"),
    deliveryStatus: partial.deliveryStatus ?? "pending",
    notifyPolicy: partial.notifyPolicy ?? "done_only",
    ownerKey: partial.ownerKey ?? partial.requesterSessionKey ?? "agent:main:main",
    requesterSessionKey: partial.requesterSessionKey ?? partial.ownerKey ?? "agent:main:main",
    runtime: partial.runtime ?? "acp",
    scopeKind: partial.scopeKind ?? "session",
    status: partial.status ?? "queued",
    task: partial.task ?? "Background task",
    taskId: partial.taskId ?? "task-1",
    ...partial,
  };
}

describe("task-registry audit", () => {
  it("flags stale running, lost, and missing cleanup tasks", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          lastEventAt: now - 40 * 60_000,
          startedAt: now - 40 * 60_000,
          status: "running",
          taskId: "stale-running",
        }),
        createTask({
          endedAt: now - 5 * 60_000,
          error: "backing session missing",
          status: "lost",
          taskId: "lost-task",
        }),
        createTask({
          cleanupAfter: undefined,
          endedAt: now - 60_000,
          status: "failed",
          taskId: "missing-cleanup",
        }),
      ],
    });

    expect(findings.map((finding) => [finding.code, finding.task.taskId])).toEqual([
      ["lost", "lost-task"],
      ["stale_running", "stale-running"],
      ["missing_cleanup", "missing-cleanup"],
    ]);
  });

  it("summarizes findings by severity and code", () => {
    const summary = summarizeTaskAuditFindings([
      {
        code: "stale_running",
        detail: "running task appears stuck",
        severity: "error",
        task: createTask({ status: "running", taskId: "a" }),
      },
      {
        code: "delivery_failed",
        detail: "terminal update delivery failed",
        severity: "warn",
        task: createTask({ status: "failed", taskId: "b" }),
      },
    ]);

    expect(summary).toEqual({
      byCode: {
        delivery_failed: 1,
        inconsistent_timestamps: 0,
        lost: 0,
        missing_cleanup: 0,
        stale_queued: 0,
        stale_running: 1,
      },
      errors: 1,
      total: 2,
      warnings: 1,
    });
  });

  it("does not double-report lost tasks as missing cleanup", () => {
    const now = Date.parse("2026-03-30T01:00:00.000Z");
    const findings = listTaskAuditFindings({
      now,
      tasks: [
        createTask({
          cleanupAfter: undefined,
          endedAt: now - 60_000,
          status: "lost",
          taskId: "lost-projected",
        }),
      ],
    });

    expect(findings.map((finding) => finding.code)).toEqual(["lost"]);
  });
});
