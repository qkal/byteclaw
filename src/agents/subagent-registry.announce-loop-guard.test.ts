import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Regression test for #18264: Gateway announcement delivery loop.
 *
 * When `runSubagentAnnounceFlow` repeatedly returns `false` (deferred),
 * `finalizeSubagentCleanup` must eventually give up rather than retrying
 * forever via the max-retry and expiration guards.
 */

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
  captureSubagentCompletionReply: vi.fn(),
  loadConfig: vi.fn(() => ({
    agents: {},
    session: { mainKey: "main", store: "/tmp/test-store" },
  })),
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  onAgentEvent: vi.fn(),
  onAgentEventStop: vi.fn(),
  resetAnnounceQueuesForTests: vi.fn(),
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(false),
  saveSubagentRegistryToDisk: vi.fn(),
  scheduleOrphanRecovery: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({
    "agent:main:subagent:child-1": { sessionId: "sess-child-1", updatedAt: 1 },
    "agent:main:subagent:expired-child": { sessionId: "sess-expired", updatedAt: 1 },
    "agent:main:subagent:retry-budget": { sessionId: "sess-retry", updatedAt: 1 },
  }),
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveStorePath: () => "/tmp/test-store",
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: mocks.loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk: mocks.saveSubagentRegistryToDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: mocks.resetAnnounceQueuesForTests,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: mocks.scheduleOrphanRecovery,
}));

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    vi.resetModules();
    registry = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.callGateway.mockClear();
    mocks.captureSubagentCompletionReply.mockClear();
    mocks.loadConfig.mockClear();
    mocks.loadSubagentRegistryFromDisk.mockReset();
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(new Map());
    mocks.onAgentEventStop.mockClear();
    mocks.onAgentEvent.mockReset();
    mocks.onAgentEvent.mockReturnValue(mocks.onAgentEventStop);
    mocks.resetAnnounceQueuesForTests.mockClear();
    mocks.resolveAgentTimeoutMs.mockClear();
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    mocks.scheduleOrphanRecovery.mockClear();
    mocks.saveSubagentRegistryToDisk.mockClear();
    mocks.updateSessionStore.mockClear();
    registry.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    registry.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("SubagentRunRecord has announceRetryCount and lastAnnounceRetryAt fields", () => {
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    // Add a run that has already ended and exhausted retries
    registry.addSubagentRunForTests({
      announceRetryCount: 3,
      childSessionKey: "agent:main:subagent:child-1",
      cleanup: "keep",
      createdAt: now - 60_000,
      endedAt: now - 50_000,
      lastAnnounceRetryAt: now - 10_000,
      requesterDisplayKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      runId: "test-loop-guard",
      startedAt: now - 55_000,
      task: "test task",
    });

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "test-loop-guard");
    expect(entry).toBeDefined();
    expect(entry!.announceRetryCount).toBe(3);
    expect(entry!.lastAnnounceRetryAt).toBeDefined();
  });

  test.each([
    {
      createEntry: (now: number) => ({
        // Ended 10 minutes ago (well past ANNOUNCE_EXPIRY_MS of 5 min).
        announceRetryCount: 3,
        childSessionKey: "agent:main:subagent:expired-child",
        cleanup: "keep" as const,
        cleanupCompletedAt: undefined,
        createdAt: now - 15 * 60_000,
        endedAt: now - 10 * 60_000,
        lastAnnounceRetryAt: now - 9 * 60_000,
        requesterDisplayKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        runId: "test-expired-loop",
        startedAt: now - 14 * 60_000,
        task: "expired test task",
      }),
      name: "expired entries with high retry count are skipped by resumeSubagentRun",
    },
    {
      createEntry: (now: number) => ({
        announceRetryCount: 3,
        childSessionKey: "agent:main:subagent:retry-budget",
        cleanup: "keep" as const,
        cleanupCompletedAt: undefined,
        createdAt: now - 2 * 60_000,
        endedAt: now - 60_000,
        lastAnnounceRetryAt: now - 30_000,
        requesterDisplayKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        runId: "test-retry-budget",
        startedAt: now - 90_000,
        task: "retry budget test",
      }),
      name: "entries over retry budget are marked completed without announcing",
    },
  ])("$name", async ({ createEntry }) => {
    mocks.runSubagentAnnounceFlow.mockClear();
    registry.resetSubagentRegistryForTests();

    const entry = createEntry(Date.now());
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));

    // Initialization attempts resume once, then gives up for exhausted entries.
    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(entry.cleanupCompletedAt).toBeDefined();
  });

  test("expired completion-message entries are still resumed for announce", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce(true);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-expired-completion-message";
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            childSessionKey: "agent:main:subagent:child-1",
            cleanup: "keep" as const,
            cleanupHandled: false,
            createdAt: now - 20 * 60_000,
            endedAt: now - 10 * 60_000,
            expectsCompletionMessage: true,
            requesterDisplayKey: "agent:main:main",
            requesterSessionKey: "agent:main:main",
            runId,
            startedAt: now - 19 * 60_000,
            task: "completion announce after long descendants",
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-announce-rejection";
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(
      new Map([
        [
          runId,
          {
            childSessionKey: "agent:main:subagent:child-1",
            cleanup: "keep" as const,
            cleanupHandled: false,
            createdAt: now - 30_000,
            endedAt: now - 10_000,
            requesterDisplayKey: "agent:main:main",
            requesterSessionKey: "agent:main:main",
            runId,
            startedAt: now - 20_000,
            task: "rejection test",
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupHandled).toBe(false);
    expect(stored?.cleanupCompletedAt).toBeUndefined();
    expect(stored?.announceRetryCount).toBe(1);
    expect(stored?.lastAnnounceRetryAt).toBeTypeOf("number");
  });
});
