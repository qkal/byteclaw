import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DedupeEntry } from "../server-shared.js";
import {
  __testing,
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";

describe("agent wait dedupe helper", () => {
  function setRunEntry(params: {
    dedupe: Map<string, DedupeEntry>;
    kind: "agent" | "chat";
    runId: string;
    ts?: number;
    ok?: boolean;
    payload: Record<string, unknown>;
  }) {
    setGatewayDedupeEntry({
      dedupe: params.dedupe,
      entry: {
        ok: params.ok ?? true,
        payload: params.payload,
        ts: params.ts ?? Date.now(),
      },
      key: `${params.kind}:${params.runId}`,
    });
  }

  beforeEach(() => {
    __testing.resetWaiters();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __testing.resetWaiters();
    vi.useRealTimers();
  });

  it("unblocks waiters when a terminal chat dedupe entry is written", async () => {
    const dedupe = new Map();
    const runId = "run-chat-terminal";
    const waiter = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(__testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "chat",
      payload: {
        endedAt: 200,
        runId,
        startedAt: 100,
        status: "ok",
      },
      runId,
    });

    await expect(waiter).resolves.toEqual({
      endedAt: 200,
      error: undefined,
      startedAt: 100,
      status: "ok",
    });
    expect(__testing.getWaiterCount(runId)).toBe(0);
  });

  it("keeps stale chat dedupe blocked while agent dedupe is in-flight", async () => {
    const dedupe = new Map();
    const runId = "run-stale-chat";
    setRunEntry({
      dedupe,
      kind: "chat",
      payload: {
        runId,
        status: "ok",
      },
      runId,
    });
    setRunEntry({
      dedupe,
      kind: "agent",
      payload: {
        runId,
        status: "accepted",
      },
      runId,
    });

    const snapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe,
      runId,
    });
    expect(snapshot).toBeNull();

    const blockedWait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(blockedWait).resolves.toBeNull();
    expect(__testing.getWaiterCount(runId)).toBe(0);
  });

  it("uses newer terminal chat snapshot when agent entry is non-terminal", () => {
    const dedupe = new Map();
    const runId = "run-nonterminal-agent-with-newer-chat";
    setRunEntry({
      dedupe,
      kind: "agent",
      payload: {
        runId,
        status: "accepted",
      },
      runId,
      ts: 100,
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      payload: {
        endedAt: 2,
        runId,
        startedAt: 1,
        status: "ok",
      },
      runId,
      ts: 200,
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      endedAt: 2,
      error: undefined,
      startedAt: 1,
      status: "ok",
    });
  });

  it("ignores stale agent snapshots when waiting for an active chat run", async () => {
    const dedupe = new Map();
    const runId = "run-chat-active-ignore-agent";
    setRunEntry({
      dedupe,
      kind: "agent",
      payload: {
        runId,
        status: "ok",
      },
      runId,
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        ignoreAgentTerminalSnapshot: true,
        runId,
      }),
    ).toBeNull();

    const wait = waitForTerminalGatewayDedupe({
      dedupe,
      ignoreAgentTerminalSnapshot: true,
      runId,
      timeoutMs: 1000,
    });
    await Promise.resolve();
    expect(__testing.getWaiterCount(runId)).toBe(1);

    setRunEntry({
      dedupe,
      kind: "chat",
      payload: {
        endedAt: 456,
        runId,
        startedAt: 123,
        status: "ok",
      },
      runId,
    });

    await expect(wait).resolves.toEqual({
      endedAt: 456,
      error: undefined,
      startedAt: 123,
      status: "ok",
    });
  });

  it("prefers the freshest terminal snapshot when agent/chat dedupe keys collide", () => {
    const runId = "run-collision";
    const dedupe = new Map();

    setRunEntry({
      dedupe,
      kind: "agent",
      payload: { endedAt: 20, runId, startedAt: 10, status: "ok" },
      runId,
      ts: 100,
    });
    setRunEntry({
      dedupe,
      kind: "chat",
      ok: false,
      payload: { endedAt: 40, error: "chat failed", runId, startedAt: 30, status: "error" },
      runId,
      ts: 200,
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe,
        runId,
      }),
    ).toEqual({
      endedAt: 40,
      error: "chat failed",
      startedAt: 30,
      status: "error",
    });

    const dedupeReverse = new Map();
    setRunEntry({
      dedupe: dedupeReverse,
      kind: "chat",
      payload: { endedAt: 2, runId, startedAt: 1, status: "ok" },
      runId,
      ts: 100,
    });
    setRunEntry({
      dedupe: dedupeReverse,
      kind: "agent",
      payload: { endedAt: 4, error: "still running", runId, startedAt: 3, status: "timeout" },
      runId,
      ts: 200,
    });

    expect(
      readTerminalSnapshotFromGatewayDedupe({
        dedupe: dedupeReverse,
        runId,
      }),
    ).toEqual({
      endedAt: 4,
      error: "still running",
      startedAt: 3,
      status: "timeout",
    });
  });

  it("resolves multiple waiters for the same run id", async () => {
    const dedupe = new Map();
    const runId = "run-multi";
    const first = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1000,
    });
    const second = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    expect(__testing.getWaiterCount(runId)).toBe(2);

    setRunEntry({
      dedupe,
      kind: "chat",
      payload: { runId, status: "ok" },
      runId,
    });

    await expect(first).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
      }),
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
      }),
    );
    expect(__testing.getWaiterCount(runId)).toBe(0);
  });

  it("cleans up waiter registration on timeout", async () => {
    const dedupe = new Map();
    const runId = "run-timeout";
    const wait = waitForTerminalGatewayDedupe({
      dedupe,
      runId,
      timeoutMs: 20,
    });

    await Promise.resolve();
    expect(__testing.getWaiterCount(runId)).toBe(1);

    await vi.advanceTimersByTimeAsync(25);
    await expect(wait).resolves.toBeNull();
    expect(__testing.getWaiterCount(runId)).toBe(0);
  });
});
