import { describe, expect, it } from "vitest";
import {
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-default";
  const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${runId}`;
  const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
  return {
    childSessionKey,
    cleanup: "keep",
    createdAt: overrides.createdAt ?? 1,
    requesterDisplayKey: requesterSessionKey,
    requesterSessionKey,
    runId,
    task: "test task",
    ...overrides,
  };
}

function toRunMap(runs: SubagentRunRecord[]): Map<string, SubagentRunRecord> {
  return new Map(runs.map((run) => [run.runId, run]));
}

describe("subagent registry query regressions", () => {
  it("regression descendant count gating, pending descendants block announce until cleanup completion is recorded", () => {
    // Regression guard: parent announce must defer while any descendant cleanup is still pending.
    const parentSessionKey = "agent:main:subagent:parent";
    const runs = toRunMap([
      makeRun({
        childSessionKey: parentSessionKey,
        cleanupCompletedAt: undefined,
        endedAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent",
      }),
      makeRun({
        childSessionKey: `${parentSessionKey}:subagent:fast`,
        cleanupCompletedAt: 120,
        endedAt: 110,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-fast",
      }),
      makeRun({
        childSessionKey: `${parentSessionKey}:subagent:slow`,
        cleanupCompletedAt: undefined,
        endedAt: 115,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-slow",
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(1);

    runs.set(
      "run-parent",
      makeRun({
        childSessionKey: parentSessionKey,
        cleanupCompletedAt: 130,
        endedAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent",
      }),
    );
    runs.set(
      "run-child-slow",
      makeRun({
        childSessionKey: `${parentSessionKey}:subagent:slow`,
        cleanupCompletedAt: 131,
        endedAt: 115,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-slow",
      }),
    );

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(0);
  });

  it("regression nested parallel counting, traversal includes child and grandchildren pending states", () => {
    // Regression guard: nested fan-out once under-counted grandchildren and announced too early.
    const parentSessionKey = "agent:main:subagent:parent-nested";
    const middleSessionKey = `${parentSessionKey}:subagent:middle`;
    const runs = toRunMap([
      makeRun({
        childSessionKey: middleSessionKey,
        cleanupCompletedAt: undefined,
        endedAt: 200,
        requesterSessionKey: parentSessionKey,
        runId: "run-middle",
      }),
      makeRun({
        childSessionKey: `${middleSessionKey}:subagent:a`,
        cleanupCompletedAt: 215,
        endedAt: 210,
        requesterSessionKey: middleSessionKey,
        runId: "run-middle-a",
      }),
      makeRun({
        childSessionKey: `${middleSessionKey}:subagent:b`,
        cleanupCompletedAt: undefined,
        endedAt: 211,
        requesterSessionKey: middleSessionKey,
        runId: "run-middle-b",
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(2);
    expect(countPendingDescendantRunsFromRuns(runs, middleSessionKey)).toBe(1);
  });

  it("dedupes restarted descendant rows for the same child session when counting pending work", () => {
    const parentSessionKey = "agent:main:subagent:parent-dedupe";
    const childSessionKey = `${parentSessionKey}:subagent:worker`;
    const runs = toRunMap([
      makeRun({
        childSessionKey,
        cleanupCompletedAt: undefined,
        createdAt: 100,
        endedAt: 150,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-stale",
      }),
      makeRun({
        childSessionKey,
        createdAt: 200,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-current",
      }),
      makeRun({
        childSessionKey: `${childSessionKey}:subagent:leaf`,
        createdAt: 210,
        requesterSessionKey: childSessionKey,
        runId: "run-grandchild-current",
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, parentSessionKey)).toBe(2);
  });

  it("ignores stale older parent rows when a child session moved to a newer controller", () => {
    const oldParentSessionKey = "agent:main:subagent:old-parent";
    const newParentSessionKey = "agent:main:subagent:new-parent";
    const childSessionKey = "agent:main:subagent:shared-child";
    const runs = toRunMap([
      makeRun({
        childSessionKey: oldParentSessionKey,
        createdAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-old-parent",
      }),
      makeRun({
        childSessionKey: newParentSessionKey,
        createdAt: 200,
        requesterSessionKey: "agent:main:main",
        runId: "run-new-parent",
      }),
      makeRun({
        childSessionKey,
        controllerSessionKey: oldParentSessionKey,
        createdAt: 300,
        endedAt: 350,
        requesterSessionKey: oldParentSessionKey,
        runId: "run-child-stale-parent",
      }),
      makeRun({
        childSessionKey,
        controllerSessionKey: newParentSessionKey,
        createdAt: 400,
        requesterSessionKey: newParentSessionKey,
        runId: "run-child-current-parent",
      }),
    ]);

    expect(countPendingDescendantRunsFromRuns(runs, oldParentSessionKey)).toBe(0);
    expect(countPendingDescendantRunsFromRuns(runs, newParentSessionKey)).toBe(1);
  });

  it("regression excluding current run, countPendingDescendantRunsExcludingRun keeps sibling gating intact", () => {
    // Regression guard: excluding the currently announcing run must not hide sibling pending work.
    const runs = toRunMap([
      makeRun({
        childSessionKey: "agent:main:subagent:self",
        cleanupCompletedAt: undefined,
        endedAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-self",
      }),
      makeRun({
        childSessionKey: "agent:main:subagent:sibling",
        cleanupCompletedAt: undefined,
        endedAt: 101,
        requesterSessionKey: "agent:main:main",
        runId: "run-sibling",
      }),
    ]);

    expect(
      countPendingDescendantRunsExcludingRunFromRuns(runs, "agent:main:main", "run-self"),
    ).toBe(1);
    expect(
      countPendingDescendantRunsExcludingRunFromRuns(runs, "agent:main:main", "run-sibling"),
    ).toBe(1);
  });

  it("counts ended orchestrators with pending descendants as active", () => {
    const parentSessionKey = "agent:main:subagent:orchestrator";
    const runs = toRunMap([
      makeRun({
        childSessionKey: parentSessionKey,
        cleanupCompletedAt: undefined,
        endedAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent-ended",
      }),
      makeRun({
        childSessionKey: `${parentSessionKey}:subagent:child`,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-active",
      }),
    ]);

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);

    runs.set(
      "run-child-active",
      makeRun({
        childSessionKey: `${parentSessionKey}:subagent:child`,
        cleanupCompletedAt: 160,
        endedAt: 150,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-active",
      }),
    );

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(0);
  });

  it("dedupes stale and current rows for the same child session when counting active runs", () => {
    const childSessionKey = "agent:main:subagent:orch-restarted";
    const runs = toRunMap([
      makeRun({
        childSessionKey,
        cleanupCompletedAt: undefined,
        createdAt: 100,
        endedAt: 150,
        requesterSessionKey: "agent:main:main",
        runId: "run-old",
        startedAt: 100,
      }),
      makeRun({
        childSessionKey,
        createdAt: 200,
        requesterSessionKey: "agent:main:main",
        runId: "run-current",
        startedAt: 200,
      }),
      makeRun({
        childSessionKey: `${childSessionKey}:subagent:child`,
        createdAt: 210,
        requesterSessionKey: childSessionKey,
        runId: "run-descendant-active",
        startedAt: 210,
      }),
    ]);

    expect(countActiveRunsForSessionFromRuns(runs, "agent:main:main")).toBe(1);
  });

  it("scopes direct child listings to the requester run window when requesterRunId is provided", () => {
    const requesterSessionKey = "agent:main:subagent:orchestrator";
    const runs = toRunMap([
      makeRun({
        childSessionKey: requesterSessionKey,
        createdAt: 100,
        endedAt: 150,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent-old",
        startedAt: 100,
      }),
      makeRun({
        childSessionKey: requesterSessionKey,
        createdAt: 200,
        endedAt: 260,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent-current",
        startedAt: 200,
      }),
      makeRun({
        childSessionKey: `${requesterSessionKey}:subagent:stale`,
        createdAt: 130,
        requesterSessionKey,
        runId: "run-child-stale",
      }),
      makeRun({
        childSessionKey: `${requesterSessionKey}:subagent:current-a`,
        createdAt: 210,
        requesterSessionKey,
        runId: "run-child-current-a",
      }),
      makeRun({
        childSessionKey: `${requesterSessionKey}:subagent:current-b`,
        createdAt: 220,
        requesterSessionKey,
        runId: "run-child-current-b",
      }),
      makeRun({
        childSessionKey: `${requesterSessionKey}:subagent:future`,
        createdAt: 270,
        requesterSessionKey,
        runId: "run-child-future",
      }),
    ]);

    const scoped = listRunsForRequesterFromRuns(runs, requesterSessionKey, {
      requesterRunId: "run-parent-current",
    });
    const scopedRunIds = scoped.map((entry) => entry.runId).toSorted();

    expect(scopedRunIds).toEqual(["run-child-current-a", "run-child-current-b"]);
  });

  it("regression post-completion gating, run-mode sessions ignore late announces after cleanup completes", () => {
    // Regression guard: late descendant announces must not reopen run-mode sessions
    // Once their own completion cleanup has fully finished.
    const childSessionKey = "agent:main:subagent:orchestrator";
    const runs = toRunMap([
      makeRun({
        childSessionKey,
        cleanupCompletedAt: 11,
        createdAt: 1,
        endedAt: 10,
        requesterSessionKey: "agent:main:main",
        runId: "run-older",
        spawnMode: "run",
      }),
      makeRun({
        childSessionKey,
        cleanupCompletedAt: 21,
        createdAt: 2,
        endedAt: 20,
        requesterSessionKey: "agent:main:main",
        runId: "run-latest",
        spawnMode: "run",
      }),
    ]);

    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, childSessionKey)).toBe(true);
  });

  it("keeps run-mode orchestrators announce-eligible while waiting on child completions", () => {
    const parentSessionKey = "agent:main:subagent:orchestrator";
    const childOneSessionKey = `${parentSessionKey}:subagent:child-one`;
    const childTwoSessionKey = `${parentSessionKey}:subagent:child-two`;

    const runs = toRunMap([
      makeRun({
        childSessionKey: parentSessionKey,
        cleanupCompletedAt: undefined,
        createdAt: 1,
        endedAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent",
        spawnMode: "run",
      }),
      makeRun({
        childSessionKey: childOneSessionKey,
        cleanupCompletedAt: undefined,
        createdAt: 2,
        endedAt: 110,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-one",
      }),
      makeRun({
        childSessionKey: childTwoSessionKey,
        cleanupCompletedAt: undefined,
        createdAt: 3,
        endedAt: 111,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-two",
      }),
    ]);

    expect(resolveRequesterForChildSessionFromRuns(runs, childOneSessionKey)).toMatchObject({
      requesterSessionKey: parentSessionKey,
    });
    expect(resolveRequesterForChildSessionFromRuns(runs, childTwoSessionKey)).toMatchObject({
      requesterSessionKey: parentSessionKey,
    });
    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parentSessionKey)).toBe(
      false,
    );

    runs.set(
      "run-child-one",
      makeRun({
        childSessionKey: childOneSessionKey,
        cleanupCompletedAt: 120,
        createdAt: 2,
        endedAt: 110,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-one",
      }),
    );
    runs.set(
      "run-child-two",
      makeRun({
        childSessionKey: childTwoSessionKey,
        cleanupCompletedAt: 121,
        createdAt: 3,
        endedAt: 111,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-two",
      }),
    );

    const childThreeSessionKey = `${parentSessionKey}:subagent:child-three`;
    runs.set(
      "run-child-three",
      makeRun({
        childSessionKey: childThreeSessionKey,
        createdAt: 4,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-three",
      }),
    );

    expect(resolveRequesterForChildSessionFromRuns(runs, childThreeSessionKey)).toMatchObject({
      requesterSessionKey: parentSessionKey,
    });
    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parentSessionKey)).toBe(
      false,
    );

    runs.set(
      "run-child-three",
      makeRun({
        childSessionKey: childThreeSessionKey,
        cleanupCompletedAt: 123,
        createdAt: 4,
        endedAt: 122,
        requesterSessionKey: parentSessionKey,
        runId: "run-child-three",
      }),
    );

    runs.set(
      "run-parent",
      makeRun({
        childSessionKey: parentSessionKey,
        cleanupCompletedAt: 130,
        createdAt: 1,
        endedAt: 100,
        requesterSessionKey: "agent:main:main",
        runId: "run-parent",
        spawnMode: "run",
      }),
    );

    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, parentSessionKey)).toBe(true);
  });

  it("regression post-completion gating, session-mode sessions keep accepting follow-up announces", () => {
    // Regression guard: persistent session-mode orchestrators must continue receiving child completions.
    const childSessionKey = "agent:main:subagent:orchestrator-session";
    const runs = toRunMap([
      makeRun({
        childSessionKey,
        createdAt: 3,
        endedAt: 30,
        requesterSessionKey: "agent:main:main",
        runId: "run-session",
        spawnMode: "session",
      }),
    ]);

    expect(shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs, childSessionKey)).toBe(false);
  });
});
