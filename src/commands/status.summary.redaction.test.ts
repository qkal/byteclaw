import { describe, expect, it } from "vitest";
import { redactSensitiveStatusSummary } from "./status.summary.js";
import type { StatusSummary } from "./status.types.js";

function createRecentSessionRow() {
  return {
    age: 2,
    contextTokens: 200_000,
    flags: ["id:sess-1"],
    key: "main",
    kind: "direct" as const,
    model: "gpt-5",
    percentUsed: 5,
    remainingTokens: 4,
    sessionId: "sess-1",
    totalTokens: 3,
    totalTokensFresh: true,
    updatedAt: 1,
  };
}

describe("redactSensitiveStatusSummary", () => {
  it("removes sensitive session and path details while preserving summary structure", () => {
    const input: StatusSummary = {
      channelSummary: ["ok"],
      heartbeat: {
        agents: [{ agentId: "main", enabled: true, every: "5m", everyMs: 300_000 }],
        defaultAgentId: "main",
      },
      queuedSystemEvents: ["none"],
      runtimeVersion: "2026.3.8",
      sessions: {
        byAgent: [
          {
            agentId: "main",
            count: 1,
            path: "/tmp/openclaw/main-sessions.json",
            recent: [createRecentSessionRow()],
          },
        ],
        count: 1,
        defaults: { contextTokens: 200_000, model: "gpt-5" },
        paths: ["/tmp/openclaw/sessions.json"],
        recent: [createRecentSessionRow()],
      },
      taskAudit: {
        byCode: {
          delivery_failed: 1,
          inconsistent_timestamps: 0,
          lost: 0,
          missing_cleanup: 0,
          stale_queued: 0,
          stale_running: 0,
        },
        errors: 0,
        total: 1,
        warnings: 1,
      },
      tasks: {
        active: 1,
        byRuntime: {
          acp: 1,
          cli: 0,
          cron: 1,
          subagent: 0,
        },
        byStatus: {
          cancelled: 0,
          failed: 1,
          lost: 0,
          queued: 1,
          running: 0,
          succeeded: 0,
          timed_out: 0,
        },
        failures: 1,
        terminal: 1,
        total: 2,
      },
    };

    const redacted = redactSensitiveStatusSummary(input);
    expect(redacted.sessions.paths).toEqual([]);
    expect(redacted.sessions.defaults).toEqual({ contextTokens: null, model: null });
    expect(redacted.sessions.recent).toEqual([]);
    expect(redacted.sessions.byAgent[0]?.path).toBe("[redacted]");
    expect(redacted.sessions.byAgent[0]?.recent).toEqual([]);
    expect(redacted.runtimeVersion).toBe("2026.3.8");
    expect(redacted.heartbeat).toEqual(input.heartbeat);
    expect(redacted.channelSummary).toEqual(input.channelSummary);
    expect(redacted.tasks).toEqual(input.tasks);
    expect(redacted.taskAudit).toEqual(input.taskAudit);
  });
});
