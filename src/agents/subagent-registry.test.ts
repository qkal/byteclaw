import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
  emitSessionLifecycleEvent: vi.fn(),
  ensureContextEnginesInitialized: vi.fn(),
  ensureRuntimePluginsLoaded: vi.fn(),
  getGlobalHookRunner: vi.fn(() => null),
  getSubagentRunsSnapshotForRead: vi.fn(
    (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) => new Map(runs),
  ),
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    session: { mainKey: "main", scope: "per-sender" as const },
  })),
  loadSessionStore: vi.fn(() => ({})),
  onAgentEvent: vi.fn(() => noop),
  onSubagentEnded: vi.fn(async () => {}),
  persistSubagentRunsToDisk: vi.fn(),
  resetAnnounceQueuesForTests: vi.fn(),
  resolveAgentIdFromSessionKey: vi.fn(
    (sessionKey: string) => sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main",
  ),
  resolveAgentTimeoutMs: vi.fn(() => 1000),
  resolveContextEngine: vi.fn(),
  resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
  runSubagentAnnounceFlow: vi.fn(async () => true),
  runSubagentEnded: vi.fn(async () => {}),
  updateSessionStore: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: mocks.resetAnnounceQueuesForTests,
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

describe("subagent registry seam flow", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.loadConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    mocks.resolveAgentIdFromSessionKey.mockImplementation(
      (sessionKey: string) => sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main",
    );
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          endedAt: 222,
          startedAt: 111,
          status: "ok",
        };
      }
      return {};
    });
    mod.__testing.setDepsForTest({
      callGateway: mocks.callGateway,
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
      ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
      onAgentEvent: mocks.onAgentEvent,
      persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
      resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
      resolveContextEngine: mocks.resolveContextEngine,
      restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
    });
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    mod.registerSubagentRun({
      childSessionKey: "agent:main:subagent:child",
      cleanup: "delete",
      requesterDisplayKey: "main",
      requesterOrigin: { accountId: " acct-1 ", channel: " discord " },
      requesterSessionKey: "agent:main:main",
      runId: "run-1",
      task: "finish the task",
    });

    await vi.waitFor(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      label: undefined,
      parentSessionKey: "agent:main:main",
      reason: "subagent-status",
      sessionKey: "agent:main:subagent:child",
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        cleanup: "delete",
        outcome: { status: "ok" },
        requesterOrigin: { accountId: "acct-1", channel: "discord" },
        requesterSessionKey: "agent:main:main",
        roundOneReply: "final completion reply",
        task: "finish the task",
      }),
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.updateSessionStore).toHaveBeenCalledWith(
      "/tmp/test-session-store.json",
      expect.any(Function),
    );

    const updateStore = mocks.updateSessionStore.mock.calls[0]?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    expect(updateStore).toBeTypeOf("function");
    const store = {
      "agent:main:subagent:child": {
        sessionId: "sess-child",
      },
    };
    updateStore?.(store);
    expect(store["agent:main:subagent:child"]).toMatchObject({
      endedAt: 222,
      runtimeMs: 111,
      startedAt: Date.parse("2026-03-24T12:00:00Z"),
      status: "done",
    });

    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("deletes delete-mode completion runs when announce cleanup gives up after retry limit", async () => {
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    const endedAt = Date.parse("2026-03-24T12:00:00Z");
    mocks.callGateway.mockResolvedValueOnce({
      endedAt,
      startedAt: endedAt - 500,
      status: "ok",
    });

    mod.registerSubagentRun({
      childSessionKey: "agent:main:subagent:child",
      cleanup: "delete",
      expectsCompletionMessage: true,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-delete-give-up",
      task: "completion cleanup retry",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeDefined();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeUndefined();
  });

  it("finalizes retry-budgeted completion delete runs during resume", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-delete", {
        announceRetryCount: 3,
        childSessionKey: "agent:main:subagent:child",
        cleanup: "delete",
        createdAt: Date.parse("2026-03-24T11:58:00Z"),
        endedAt: Date.parse("2026-03-24T11:59:30Z"),
        expectsCompletionMessage: true,
        lastAnnounceRetryAt: Date.parse("2026-03-24T11:59:40Z"),
        requesterDisplayKey: "main",
        requesterSessionKey: "agent:main:main",
        runId: "run-resume-delete",
        startedAt: Date.parse("2026-03-24T11:59:00Z"),
        task: "resume delete retry budget",
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:child",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resume-delete"),
    ).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
    });

    mod.addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:parent",
      cleanup: "delete",
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: Date.parse("2026-03-24T11:50:00Z"),
      endedAt: Date.parse("2026-03-24T11:51:00Z"),
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-parent-expired",
      startedAt: Date.parse("2026-03-24T11:50:30Z"),
      task: "expired parent cleanup",
    });

    mod.registerSubagentRun({
      childSessionKey: "agent:main:subagent:child",
      cleanup: "keep",
      requesterDisplayKey: "parent",
      requesterSessionKey: "agent:main:subagent:parent",
      runId: "run-child-finished",
      task: "descendant settles",
    });

    await vi.waitFor(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === "run-parent-expired"),
      ).toBeUndefined();
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: "run-child-finished",
      }),
    );
    await vi.waitFor(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:parent",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
  });

  it("loads runtime plugins before emitting killed subagent ended hooks", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.ensureRuntimePluginsLoaded.mockImplementation(() => {
      mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    });

    mod.registerSubagentRun({
      childSessionKey: "agent:main:subagent:killed",
      cleanup: "keep",
      requesterDisplayKey: "main",
      requesterOrigin: { accountId: "acct-1", channel: "discord" },
      requesterSessionKey: "agent:main:main",
      runId: "run-killed-init",
      task: "kill after init",
      workspaceDir: "/tmp/killed-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      reason: "manual kill",
      runId: "run-killed-init",
    });

    expect(updated).toBe(1);
    await vi.waitFor(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
        allowGatewaySubagentBinding: true,
        config: {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        workspaceDir: "/tmp/killed-workspace",
      });
    });
    expect(mocks.runSubagentEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        error: "manual kill",
        outcome: "killed",
        reason: "subagent-killed",
        runId: "run-killed-init",
        targetSessionKey: "agent:main:subagent:killed",
      }),
      expect.objectContaining({
        childSessionKey: "agent:main:subagent:killed",
        requesterSessionKey: "agent:main:main",
        runId: "run-killed-init",
      }),
    );
  });

  it("deletes killed delete-mode runs and notifies deleted cleanup", async () => {
    mod.registerSubagentRun({
      childSessionKey: "agent:main:subagent:killed-delete",
      cleanup: "delete",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-killed-delete",
      task: "kill and delete",
      workspaceDir: "/tmp/killed-delete-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      reason: "manual kill",
      runId: "run-killed-delete",
    });

    expect(updated).toBe(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-delete"),
    ).toBeUndefined();
    await vi.waitFor(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:killed-delete",
        reason: "deleted",
        workspaceDir: "/tmp/killed-delete-workspace",
      });
    });
  });

  it("removes attachments for killed delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-kill-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.registerSubagentRun({
      attachmentsDir,
      attachmentsRootDir,
      childSessionKey: "agent:main:subagent:killed-delete-attachments",
      cleanup: "delete",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-killed-delete-attachments",
      task: "kill and delete attachments",
    });

    const updated = mod.markSubagentRunTerminated({
      reason: "manual kill",
      runId: "run-killed-delete-attachments",
    });

    expect(updated).toBe(1);
    await vi.waitFor(async () => {
      await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes attachments for released delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-release-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.addSubagentRunForTests({
      accumulatedRuntimeMs: 0,
      attachmentsDir,
      attachmentsRootDir,
      childSessionKey: "agent:main:subagent:release-delete",
      cleanup: "delete",
      cleanupHandled: false,
      controllerSessionKey: "agent:main:main",
      createdAt: 1,
      expectsCompletionMessage: undefined,
      requesterDisplayKey: "main",
      requesterOrigin: undefined,
      requesterSessionKey: "agent:main:main",
      runId: "run-release-delete",
      sessionStartedAt: 1,
      spawnMode: "run",
      startedAt: 1,
      task: "release attachments",
    });

    mod.releaseSubagentRun("run-release-delete");

    await vi.waitFor(async () => {
      await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
    await vi.waitFor(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:release-delete",
        reason: "released",
        workspaceDir: undefined,
      });
    });
  });

  it("loads plugin and context-engine runtime before released end hooks", async () => {
    mod.addSubagentRunForTests({
      accumulatedRuntimeMs: 0,
      childSessionKey: "agent:main:session:child",
      cleanup: "keep",
      cleanupHandled: false,
      controllerSessionKey: "agent:main:session:parent",
      createdAt: 1,
      expectsCompletionMessage: undefined,
      requesterDisplayKey: "parent",
      requesterOrigin: undefined,
      requesterSessionKey: "agent:main:session:parent",
      runId: "run-release-context-engine",
      sessionStartedAt: 1,
      spawnMode: "run",
      startedAt: 1,
      task: "task",
      workspaceDir: "/tmp/workspace",
    });

    mod.releaseSubagentRun("run-release-context-engine");

    await vi.waitFor(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:session:child",
        reason: "released",
        workspaceDir: "/tmp/workspace",
      });
    });
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      allowGatewaySubagentBinding: true,
      config: {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
  });
});
