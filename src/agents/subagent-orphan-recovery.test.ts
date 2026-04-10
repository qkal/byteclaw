import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions.js";
import * as gateway from "../gateway/call.js";
import * as sessionUtils from "../gateway/session-utils.fs.js";
import { recoverOrphanedSubagentSessions } from "./subagent-orphan-recovery.js";
import * as subagentRegistryRuntime from "./subagent-registry-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Mock dependencies before importing the module under test
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "test-run-id" })),
}));

vi.mock("../gateway/session-utils.fs.js", () => ({
  readSessionMessages: vi.fn(() => []),
}));

vi.mock("./subagent-registry-runtime.js", () => ({
  replaceSubagentRunAfterSteer: vi.fn(() => true),
}));

function createTestRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    childSessionKey: "agent:main:subagent:test-session-1",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    requesterDisplayKey: "main",
    requesterSessionKey: "agent:main:signal:direct:+1234567890",
    runId: "run-1",
    startedAt: Date.now() - 55_000,
    task: "Test task: implement feature X",
    ...overrides,
  };
}

function createActiveRuns(...runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run] satisfies [string, SubagentRunRecord]));
}

async function expectSkippedRecovery(store: ReturnType<typeof sessions.loadSessionStore>) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

  const result = await recoverOrphanedSubagentSessions({
    getActiveRuns: () => createActiveRuns(createTestRunRecord()),
  });

  expect(result.recovered).toBe(0);
  expect(result.skipped).toBe(1);
  expect(gateway.callGateway).not.toHaveBeenCalled();
}

describe("subagent-orphan-recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers orphaned sessions with abortedLastRun=true", async () => {
    const sessionEntry = {
      abortedLastRun: true,
      sessionId: "session-abc",
      updatedAt: Date.now(),
    };

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": sessionEntry,
    });

    const run = createTestRunRecord();
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", run);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Should have called callGateway to resume the session
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(gateway.callGateway).mock.calls[0];
    const opts = callArgs[0];
    expect(opts.method).toBe("agent");
    const params = opts.params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:main:subagent:test-session-1");
    expect(params.message).toContain("gateway reload");
    expect(params.message).toContain("Test task: implement feature X");
    expect(subagentRegistryRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        fallback: run,
        nextRunId: "test-run-id",
        previousRunId: "run-1",
      }),
    );
  });

  it("skips sessions that are not aborted", async () => {
    await expectSkippedRecovery({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: false,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });
  });

  it("skips runs that have already ended", async () => {
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-1",
      createTestRunRecord({
        endedAt: Date.now() - 1000,
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("recovers restart-aborted timeout runs even when the registry marked them ended", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    const activeRuns = createActiveRuns(
      createTestRunRecord({
        endedAt: Date.now() - 1000,
        outcome: {
          status: "timeout",
        },
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("handles multiple orphaned sessions", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:session-a": {
        abortedLastRun: true,
        sessionId: "id-a",
        updatedAt: Date.now(),
      },
      "agent:main:subagent:session-b": {
        abortedLastRun: true,
        sessionId: "id-b",
        updatedAt: Date.now(),
      },
      "agent:main:subagent:session-c": {
        abortedLastRun: false,
        sessionId: "id-c",
        updatedAt: Date.now(),
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-a",
      createTestRunRecord({
        childSessionKey: "agent:main:subagent:session-a",
        runId: "run-a",
        task: "Task A",
      }),
    );
    activeRuns.set(
      "run-b",
      createTestRunRecord({
        childSessionKey: "agent:main:subagent:session-b",
        runId: "run-b",
        task: "Task B",
      }),
    );
    activeRuns.set(
      "run-c",
      createTestRunRecord({
        childSessionKey: "agent:main:subagent:session-c",
        runId: "run-c",
        task: "Task C",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
  });

  it("handles callGateway failure gracefully and preserves abortedLastRun flag", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("gateway unavailable"));

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);

    // AbortedLastRun flag should NOT be cleared on failure,
    // So the next restart can retry the recovery
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
  });

  it("returns empty results when no active runs exist", async () => {
    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map(),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips sessions with missing session entry in store", async () => {
    await expectSkippedRecovery({});
  });

  it("clears abortedLastRun flag after successful resume", async () => {
    // Ensure callGateway succeeds for this test
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    // UpdateSessionStore should have been called AFTER successful resume to clear the flag
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
    const {calls} = vi.mocked(sessions.updateSessionStore).mock;
    const [storePath, updater] = calls[0];
    expect(storePath).toBe("/tmp/test-sessions.json");

    // Simulate the updater to verify it clears abortedLastRun
    const mockStore: Record<string, { abortedLastRun?: boolean; updatedAt?: number }> = {
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        updatedAt: 0,
      },
    };
    (updater as (store: Record<string, unknown>) => void)(mockStore);
    expect(mockStore["agent:main:subagent:test-session-1"]?.abortedLastRun).toBe(false);
  });

  it("truncates long task descriptions in resume message", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    const longTask = "x".repeat(5000);
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord({ task: longTask }));

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    const callArgs = vi.mocked(gateway.callGateway).mock.calls[0];
    const opts = callArgs[0];
    const params = opts.params as Record<string, unknown>;
    const message = params.message as string;
    // Message should contain truncated task (2000 chars + "...")
    expect(message.length).toBeLessThan(5000);
    expect(message).toContain("...");
  });

  it("includes last human message in resume when available", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionFile: "session-abc.jsonl",
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      { content: [{ text: "Please build feature Y", type: "text" }], role: "user" },
      { content: [{ text: "Working on it...", type: "text" }], role: "assistant" },
      { content: [{ text: "Also add tests for it", type: "text" }], role: "user" },
      { content: [{ text: "Sure, adding tests now.", type: "text" }], role: "assistant" },
    ]);

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const callArgs = vi.mocked(gateway.callGateway).mock.calls[0];
    const params = callArgs[0].params as Record<string, unknown>;
    const message = params.message as string;
    expect(message).toContain("Also add tests for it");
    expect(message).toContain("last message from the user");
  });

  it("adds config change hint when assistant messages reference config modifications", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    vi.mocked(sessionUtils.readSessionMessages).mockReturnValue([
      { content: "Update the config", role: "user" },
      { content: "I've modified openclaw.json to add the new setting.", role: "assistant" },
    ]);

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const callArgs = vi.mocked(gateway.callGateway).mock.calls[0];
    const params = callArgs[0].params as Record<string, unknown>;
    const message = params.message as string;
    expect(message).toContain("config changes from your previous run were already applied");
  });

  it("prevents duplicate resume when updateSessionStore fails", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(sessions.updateSessionStore).mockRejectedValue(new Error("write failed"));

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    activeRuns.set(
      "run-2",
      createTestRunRecord({
        runId: "run-2",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("does not retry a session after the gateway accepted resume but run remap failed", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(subagentRegistryRuntime.replaceSubagentRunAfterSteer).mockReturnValue(false);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        sessionId: "session-abc",
        updatedAt: Date.now(),
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    const resumedSessionKeys = new Set<string>();

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });
    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });

    expect(first.recovered).toBe(1);
    expect(first.failed).toBe(0);
    expect(second.recovered).toBe(0);
    expect(second.skipped).toBe(1);
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
  });
});
