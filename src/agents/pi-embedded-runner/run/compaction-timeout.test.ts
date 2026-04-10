import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  resolveRunTimeoutDuringCompaction,
  resolveRunTimeoutWithCompactionGraceMs,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";

function expectSelectedSnapshot(params: {
  currentSessionId: string;
  currentSnapshot: Parameters<typeof selectCompactionTimeoutSnapshot>[0]["currentSnapshot"];
  expectedSessionIdUsed: string;
  expectedSnapshot: readonly ReturnType<typeof castAgentMessage>[];
  expectedSource: "current" | "pre-compaction";
  preCompactionSessionId: string;
  preCompactionSnapshot: Parameters<
    typeof selectCompactionTimeoutSnapshot
  >[0]["preCompactionSnapshot"];
  timedOutDuringCompaction: boolean;
}) {
  const selected = selectCompactionTimeoutSnapshot({
    currentSessionId: params.currentSessionId,
    currentSnapshot: params.currentSnapshot,
    preCompactionSessionId: params.preCompactionSessionId,
    preCompactionSnapshot: params.preCompactionSnapshot,
    timedOutDuringCompaction: params.timedOutDuringCompaction,
  });
  expect(selected.source).toBe(params.expectedSource);
  expect(selected.sessionIdUsed).toBe(params.expectedSessionIdUsed);
  expect(selected.messagesSnapshot).toEqual(params.expectedSnapshot);
}

describe("compaction-timeout helpers", () => {
  it("flags compaction timeout consistently for internal and external timeout sources", () => {
    const internalTimer = shouldFlagCompactionTimeout({
      isCompactionInFlight: false,
      isCompactionPendingOrRetrying: true,
      isTimeout: true,
    });
    const externalAbort = shouldFlagCompactionTimeout({
      isCompactionInFlight: false,
      isCompactionPendingOrRetrying: true,
      isTimeout: true,
    });
    expect(internalTimer).toBe(true);
    expect(externalAbort).toBe(true);
  });

  it("does not flag when timeout is false", () => {
    expect(
      shouldFlagCompactionTimeout({
        isCompactionInFlight: true,
        isCompactionPendingOrRetrying: true,
        isTimeout: false,
      }),
    ).toBe(false);
  });

  it("extends the first run timeout reached during compaction", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        graceAlreadyUsed: false,
        isCompactionInFlight: true,
        isCompactionPendingOrRetrying: false,
      }),
    ).toBe("extend");
  });

  it("aborts after compaction grace has already been used", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        graceAlreadyUsed: true,
        isCompactionInFlight: false,
        isCompactionPendingOrRetrying: true,
      }),
    ).toBe("abort");
  });

  it("aborts immediately when no compaction is active", () => {
    expect(
      resolveRunTimeoutDuringCompaction({
        graceAlreadyUsed: false,
        isCompactionInFlight: false,
        isCompactionPendingOrRetrying: false,
      }),
    ).toBe("abort");
  });

  it("adds one compaction grace window to the run timeout budget", () => {
    expect(
      resolveRunTimeoutWithCompactionGraceMs({
        compactionTimeoutMs: 900_000,
        runTimeoutMs: 600_000,
      }),
    ).toBe(1_500_000);
  });

  it("uses pre-compaction snapshot when compaction timeout occurs", () => {
    const pre = [castAgentMessage({ content: "pre", role: "assistant" })] as const;
    const current = [castAgentMessage({ content: "current", role: "assistant" })] as const;
    expectSelectedSnapshot({
      currentSessionId: "session-current",
      currentSnapshot: [...current],
      expectedSessionIdUsed: "session-pre",
      expectedSnapshot: pre,
      expectedSource: "pre-compaction",
      preCompactionSessionId: "session-pre",
      preCompactionSnapshot: [...pre],
      timedOutDuringCompaction: true,
    });
  });

  it("falls back to current snapshot when pre-compaction snapshot is unavailable", () => {
    const current = [castAgentMessage({ content: "current", role: "assistant" })] as const;
    expectSelectedSnapshot({
      currentSessionId: "session-current",
      currentSnapshot: [...current],
      expectedSessionIdUsed: "session-current",
      expectedSnapshot: current,
      expectedSource: "current",
      preCompactionSessionId: "session-pre",
      preCompactionSnapshot: null,
      timedOutDuringCompaction: true,
    });
  });
});
