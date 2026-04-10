import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
} from "./subagents-utils.js";

const NOW_MS = 1_700_000_000_000;

function makeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const id = overrides.runId ?? "run-default";
  return {
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${id}`,
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? NOW_MS - 2000,
    requesterDisplayKey: overrides.requesterDisplayKey ?? "main",
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:main",
    runId: id,
    task: overrides.task ?? "default task",
    ...overrides,
  };
}

function resolveTarget(runs: SubagentRunRecord[], token: string | undefined) {
  return resolveSubagentTargetFromRuns({
    errors: {
      ambiguousLabel: (value) => `ambiguous-label:${value}`,
      ambiguousLabelPrefix: (value) => `ambiguous-prefix:${value}`,
      ambiguousRunIdPrefix: (value) => `ambiguous-run:${value}`,
      invalidIndex: (value) => `invalid:${value}`,
      missingTarget: "missing",
      unknownSession: (value) => `unknown-session:${value}`,
      unknownTarget: (value) => `unknown:${value}`,
    },
    label: (entry) => resolveSubagentLabel(entry),
    recentWindowMinutes: 30,
    runs,
    token,
  });
}

describe("subagents utils", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves subagent label with fallback", () => {
    expect(resolveSubagentLabel(makeRun({ label: "  runner " }))).toBe("runner");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: "  task value " }))).toBe("task value");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: " " }), "fallback")).toBe("fallback");
  });

  it("sorts by startedAt then createdAt descending", () => {
    const sorted = sortSubagentRuns([
      makeRun({ createdAt: 10, runId: "a" }),
      makeRun({ createdAt: 5, runId: "b", startedAt: 15 }),
      makeRun({ createdAt: 20, runId: "c", startedAt: 12 }),
    ]);
    expect(sorted.map((entry) => entry.runId)).toEqual(["b", "c", "a"]);
  });

  it("selects last from sorted runs", () => {
    const runs = [
      makeRun({ createdAt: NOW_MS - 2000, runId: "old" }),
      makeRun({ createdAt: NOW_MS - 500, runId: "new" }),
    ];
    const resolved = resolveTarget(runs, " last ");
    expect(resolved.entry?.runId).toBe("new");
  });

  it("resolves numeric index from running then recent finished order", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const runs = [
      makeRun({
        createdAt: NOW_MS - 8000,
        label: "running",
        runId: "running",
      }),
      makeRun({
        createdAt: NOW_MS - 6000,
        endedAt: NOW_MS - 60_000,
        label: "recent",
        runId: "recent-finished",
      }),
      makeRun({
        createdAt: NOW_MS - 7000,
        endedAt: NOW_MS - 2 * 60 * 60 * 1000,
        label: "old",
        runId: "old-finished",
      }),
    ];

    expect(resolveTarget(runs, "1").entry?.runId).toBe("running");
    expect(resolveTarget(runs, "2").entry?.runId).toBe("recent-finished");
    expect(resolveTarget(runs, "3").error).toBe("invalid:3");
  });

  it("resolves session key target and unknown session errors", () => {
    const run = makeRun({ childSessionKey: "agent:beta:subagent:xyz", runId: "abc123" });
    expect(resolveTarget([run], "agent:beta:subagent:xyz").entry?.runId).toBe("abc123");
    expect(resolveTarget([run], "agent:beta:subagent:missing").error).toBe(
      "unknown-session:agent:beta:subagent:missing",
    );
  });

  it("resolves exact label, prefix, run-id prefix and ambiguity errors", () => {
    const runs = [
      makeRun({ label: "Alpha Core", runId: "run-alpha-1" }),
      makeRun({ label: "Alpha Orbit", runId: "run-alpha-2" }),
      makeRun({ label: "Beta Worker", runId: "run-beta-1" }),
    ];

    expect(resolveTarget(runs, "beta worker").entry?.runId).toBe("run-beta-1");
    expect(resolveTarget(runs, "beta").entry?.runId).toBe("run-beta-1");
    expect(resolveTarget(runs, "run-beta").entry?.runId).toBe("run-beta-1");

    expect(resolveTarget(runs, "alpha core").entry?.runId).toBe("run-alpha-1");
    expect(resolveTarget(runs, "alpha").error).toBe("ambiguous-prefix:alpha");
    expect(resolveTarget(runs, "run-alpha").error).toBe("ambiguous-run:run-alpha");
    expect(resolveTarget(runs, "missing").error).toBe("unknown:missing");
    expect(resolveTarget(runs, undefined).error).toBe("missing");
  });

  it("returns ambiguous exact label error before prefix/run id matching", () => {
    const runs = [
      makeRun({ label: "dup", runId: "run-a" }),
      makeRun({ label: "dup", runId: "run-b" }),
    ];
    expect(resolveTarget(runs, "dup").error).toBe("ambiguous-label:dup");
  });

  it("prefers the current live row when stale and current runs share a label on one child session", () => {
    const runs = [
      makeRun({
        childSessionKey: "agent:main:subagent:worker",
        createdAt: NOW_MS - 10_000,
        endedAt: NOW_MS - 5000,
        label: "same worker",
        runId: "run-old",
        startedAt: NOW_MS - 10_000,
      }),
      makeRun({
        childSessionKey: "agent:main:subagent:worker",
        createdAt: NOW_MS - 1000,
        label: "same worker",
        runId: "run-new",
        startedAt: NOW_MS - 1000,
      }),
    ];

    expect(resolveTarget(runs, "same worker").entry?.runId).toBe("run-new");
  });
});
