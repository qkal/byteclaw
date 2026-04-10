import { beforeEach, describe, expect, it } from "vitest";
import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import {
  countPendingDescendantRunsFromRuns,
  listRunsForControllerFromRuns,
} from "../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../agents/subagent-registry-state.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import { buildSubagentsStatusLine } from "./commands-status-subagents.js";

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("subagents status", () => {
  it.each([
    {
      expectedText: [] as string[],
      name: "omits subagent status line when none exist",
      seedRuns: () => undefined,
      unexpectedText: ["Subagents:"],
      verboseLevel: "on" as const,
    },
    {
      expectedText: ["🤖 Subagents: 1 active"],
      name: "includes subagent count in /status when active",
      seedRuns: () => {
        addSubagentRunForTests({
          childSessionKey: "agent:main:subagent:abc",
          cleanup: "keep",
          createdAt: 1000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-1",
          startedAt: 1000,
          task: "do thing",
        });
      },
      unexpectedText: [] as string[],
      verboseLevel: "off" as const,
    },
    {
      expectedText: ["🤖 Subagents: 1 active", "· 1 done"],
      name: "includes subagent details in /status when verbose",
      seedRuns: () => {
        addSubagentRunForTests({
          childSessionKey: "agent:main:subagent:abc",
          cleanup: "keep",
          createdAt: 1000,
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-1",
          startedAt: 1000,
          task: "do thing",
        });
        addSubagentRunForTests({
          childSessionKey: "agent:main:subagent:def",
          cleanup: "keep",
          createdAt: 900,
          endedAt: 1200,
          outcome: { status: "ok" },
          requesterDisplayKey: "main",
          requesterSessionKey: "agent:main:main",
          runId: "run-2",
          startedAt: 900,
          task: "finished task",
        });
      },
      unexpectedText: [] as string[],
      verboseLevel: "on" as const,
    },
  ])("$name", ({ seedRuns, verboseLevel, expectedText, unexpectedText }) => {
    seedRuns();
    const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
    const runs = listRunsForControllerFromRuns(runsSnapshot, "agent:main:main");
    const text =
      buildSubagentsStatusLine({
        pendingDescendantsForRun: (entry) =>
          countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey),
        runs,
        verboseEnabled: verboseLevel === "on",
      }) ?? "";
    for (const expected of expectedText) {
      expect(text).toContain(expected);
    }
    for (const blocked of unexpectedText) {
      expect(text).not.toContain(blocked);
    }
  });
});
