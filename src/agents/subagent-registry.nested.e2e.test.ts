import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    })),
  };
});

vi.mock("./subagent-announce.js", () => ({
  buildSubagentSystemPrompt: vi.fn(() => "test prompt"),
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

let subagentRegistry: typeof import("./subagent-registry.js");

describe("subagent registry nested agent tracking", () => {
  beforeAll(async () => {
    subagentRegistry = await import("./subagent-registry.js");
  });

  afterEach(() => {
    subagentRegistry.resetSubagentRegistryForTests({ persist: false });
  });

  it("listSubagentRunsForRequester returns children of the requesting session", async () => {
    const { registerSubagentRun, listSubagentRunsForRequester } = subagentRegistry;

    // Main agent spawns a depth-1 orchestrator
    registerSubagentRun({
      childSessionKey: "agent:main:subagent:orch-uuid",
      cleanup: "keep",
      label: "orchestrator",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-orch",
      task: "orchestrate something",
    });

    // Depth-1 orchestrator spawns a depth-2 leaf
    registerSubagentRun({
      childSessionKey: "agent:main:subagent:orch-uuid:subagent:leaf-uuid",
      cleanup: "keep",
      label: "leaf",
      requesterDisplayKey: "subagent:orch-uuid",
      requesterSessionKey: "agent:main:subagent:orch-uuid",
      runId: "run-leaf",
      task: "do leaf work",
    });

    // Main sees its direct child (the orchestrator)
    const mainRuns = listSubagentRunsForRequester("agent:main:main");
    expect(mainRuns).toHaveLength(1);
    expect(mainRuns[0].runId).toBe("run-orch");

    // Orchestrator sees its direct child (the leaf)
    const orchRuns = listSubagentRunsForRequester("agent:main:subagent:orch-uuid");
    expect(orchRuns).toHaveLength(1);
    expect(orchRuns[0].runId).toBe("run-leaf");

    // Leaf has no children
    const leafRuns = listSubagentRunsForRequester(
      "agent:main:subagent:orch-uuid:subagent:leaf-uuid",
    );
    expect(leafRuns).toHaveLength(0);
  });

  it("announce uses requesterSessionKey to route to the correct parent", async () => {
    const { registerSubagentRun } = subagentRegistry;
    // Register a sub-sub-agent whose parent is a sub-agent
    registerSubagentRun({
      childSessionKey: "agent:main:subagent:orch:subagent:child",
      cleanup: "keep",
      label: "nested-leaf",
      requesterDisplayKey: "subagent:orch",
      requesterSessionKey: "agent:main:subagent:orch",
      runId: "run-subsub",
      task: "nested task",
    });

    // When announce fires for the sub-sub-agent, it should target the sub-agent (depth-1),
    // NOT the main session. The registry entry's requesterSessionKey ensures this.
    // We verify the registry entry has the correct requesterSessionKey.
    const { listSubagentRunsForRequester } = subagentRegistry;
    const orchRuns = listSubagentRunsForRequester("agent:main:subagent:orch");
    expect(orchRuns).toHaveLength(1);
    expect(orchRuns[0].requesterSessionKey).toBe("agent:main:subagent:orch");
    expect(orchRuns[0].childSessionKey).toBe("agent:main:subagent:orch:subagent:child");
  });

  it("countActiveRunsForSession only counts active children of the specific session", async () => {
    const { registerSubagentRun, countActiveRunsForSession } = subagentRegistry;

    // Main spawns orchestrator (active)
    registerSubagentRun({
      childSessionKey: "agent:main:subagent:orch1",
      cleanup: "keep",
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-orch-active",
      task: "orchestrate",
    });

    // Orchestrator spawns two leaves
    registerSubagentRun({
      childSessionKey: "agent:main:subagent:orch1:subagent:leaf1",
      cleanup: "keep",
      requesterDisplayKey: "subagent:orch1",
      requesterSessionKey: "agent:main:subagent:orch1",
      runId: "run-leaf-1",
      task: "leaf 1",
    });

    registerSubagentRun({
      childSessionKey: "agent:main:subagent:orch1:subagent:leaf2",
      cleanup: "keep",
      requesterDisplayKey: "subagent:orch1",
      requesterSessionKey: "agent:main:subagent:orch1",
      runId: "run-leaf-2",
      task: "leaf 2",
    });

    // Main has 1 active child
    expect(countActiveRunsForSession("agent:main:main")).toBe(1);

    // Orchestrator has 2 active children
    expect(countActiveRunsForSession("agent:main:subagent:orch1")).toBe(2);
  });

  it("countActiveDescendantRuns traverses through ended parents", async () => {
    const { addSubagentRunForTests, countActiveDescendantRuns } = subagentRegistry;

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:orch-ended",
      cleanup: "keep",
      cleanupHandled: false,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-parent-ended",
      startedAt: 1,
      task: "orchestrate",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:orch-ended:subagent:leaf",
      cleanup: "keep",
      cleanupHandled: false,
      createdAt: 1,
      requesterDisplayKey: "orch-ended",
      requesterSessionKey: "agent:main:subagent:orch-ended",
      runId: "run-leaf-active",
      startedAt: 1,
      task: "leaf",
    });

    expect(countActiveDescendantRuns("agent:main:main")).toBe(1);
    expect(countActiveDescendantRuns("agent:main:subagent:orch-ended")).toBe(1);
  });

  it("countPendingDescendantRuns includes ended descendants until cleanup completes", async () => {
    const { addSubagentRunForTests, countPendingDescendantRuns } = subagentRegistry;

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:orch-pending",
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-parent-ended-pending",
      startedAt: 1,
      task: "orchestrate",
    });
    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:orch-pending:subagent:leaf",
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: true,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "orch-pending",
      requesterSessionKey: "agent:main:subagent:orch-pending",
      runId: "run-leaf-ended-pending",
      startedAt: 1,
      task: "leaf",
    });

    expect(countPendingDescendantRuns("agent:main:main")).toBe(2);
    expect(countPendingDescendantRuns("agent:main:subagent:orch-pending")).toBe(1);

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:orch-pending:subagent:leaf-completed",
      cleanup: "keep",
      cleanupCompletedAt: 3,
      cleanupHandled: true,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "orch-pending",
      requesterSessionKey: "agent:main:subagent:orch-pending",
      runId: "run-leaf-completed",
      startedAt: 1,
      task: "leaf complete",
    });
    expect(countPendingDescendantRuns("agent:main:subagent:orch-pending")).toBe(1);
  });

  it("keeps parent pending for parallel children until both descendants complete cleanup", async () => {
    const { addSubagentRunForTests, countPendingDescendantRuns } = subagentRegistry;
    const parentSessionKey = "agent:main:subagent:orch-parallel";

    addSubagentRunForTests({
      childSessionKey: parentSessionKey,
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-parent-parallel",
      startedAt: 1,
      task: "parallel orchestrator",
    });
    addSubagentRunForTests({
      childSessionKey: `${parentSessionKey}:subagent:leaf-a`,
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: true,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "orch-parallel",
      requesterSessionKey: parentSessionKey,
      runId: "run-leaf-a",
      startedAt: 1,
      task: "leaf a",
    });
    addSubagentRunForTests({
      childSessionKey: `${parentSessionKey}:subagent:leaf-b`,
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: 1,
      requesterDisplayKey: "orch-parallel",
      requesterSessionKey: parentSessionKey,
      runId: "run-leaf-b",
      startedAt: 1,
      task: "leaf b",
    });

    expect(countPendingDescendantRuns(parentSessionKey)).toBe(2);

    addSubagentRunForTests({
      childSessionKey: `${parentSessionKey}:subagent:leaf-a`,
      cleanup: "keep",
      cleanupCompletedAt: 3,
      cleanupHandled: true,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "orch-parallel",
      requesterSessionKey: parentSessionKey,
      runId: "run-leaf-a",
      startedAt: 1,
      task: "leaf a",
    });
    expect(countPendingDescendantRuns(parentSessionKey)).toBe(1);

    addSubagentRunForTests({
      childSessionKey: `${parentSessionKey}:subagent:leaf-b`,
      cleanup: "keep",
      cleanupCompletedAt: 5,
      cleanupHandled: true,
      createdAt: 1,
      endedAt: 4,
      requesterDisplayKey: "orch-parallel",
      requesterSessionKey: parentSessionKey,
      runId: "run-leaf-b",
      startedAt: 1,
      task: "leaf b",
    });
    expect(countPendingDescendantRuns(parentSessionKey)).toBe(0);
  });

  it("countPendingDescendantRunsExcludingRun ignores only the active announce run", async () => {
    const { addSubagentRunForTests, countPendingDescendantRunsExcludingRun } = subagentRegistry;

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:worker",
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-self",
      startedAt: 1,
      task: "self",
    });

    addSubagentRunForTests({
      childSessionKey: "agent:main:subagent:sibling",
      cleanup: "keep",
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: 1,
      endedAt: 2,
      requesterDisplayKey: "main",
      requesterSessionKey: "agent:main:main",
      runId: "run-sibling",
      startedAt: 1,
      task: "sibling",
    });

    expect(countPendingDescendantRunsExcludingRun("agent:main:main", "run-self")).toBe(1);
    expect(countPendingDescendantRunsExcludingRun("agent:main:main", "run-sibling")).toBe(1);
  });
});
