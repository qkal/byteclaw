import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const cleanOldMediaMock = vi.fn(async () => {});

vi.mock("../media/store.js", async () => {
  const actual = await vi.importActual<typeof import("../media/store.js")>("../media/store.js");
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
  };
});

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;
const ABORTED_RUN_TTL_MS = 60 * 60_000;

function createActiveRun(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    expiresAtMs: now + ABORTED_RUN_TTL_MS,
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
  };
}

function createMaintenanceTimerDeps() {
  return {
    agentRunSeq: new Map(),
    broadcast: () => {},
    chatAbortControllers: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaSentAt: new Map(),
    chatRunBuffers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    dedupe: new Map(),
    getHealthVersion: () => 1,
    getPresenceVersion: () => 1,
    logHealth: { error: () => {} },
    nodeSendToAllSubscribed: () => {},
    nodeSendToSession: () => {},
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    removeChatRun: () => undefined,
  };
}

function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  mediaCleanup: NodeJS.Timeout | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.mediaCleanup) {
    clearInterval(timers.mediaCleanup);
  }
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not schedule recursive media cleanup unless ttl is configured", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    expect(timers.mediaCleanup).toBeNull();

    stopMaintenanceTimers(timers);
  });

  it("runs startup media cleanup and repeats it hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      pruneEmptyDirs: true,
      recursive: true,
    });

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      pruneEmptyDirs: true,
      recursive: true,
    });

    stopMaintenanceTimers(timers);
  });

  it("skips overlapping media cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    let cleanupReady = false;
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
          cleanupReady = true;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    if (cleanupReady) {
      resolveCleanup();
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    stopMaintenanceTimers(timers);
  });

  it("keeps stale buffers for active runs that still have abort controllers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-active";
    deps.chatAbortControllers.set(runId, createActiveRun("main"));
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunBuffers.get(runId)).toBe("buffer");
    expect(deps.chatDeltaSentAt.has(runId)).toBe(true);
    expect(deps.chatDeltaLastBroadcastLen.get(runId)).toBe(6);

    stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned stale buffers once the abort controller is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-orphaned";
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunBuffers.has(runId)).toBe(false);
    expect(deps.chatDeltaSentAt.has(runId)).toBe(false);
    expect(deps.chatDeltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("clears deltaLastBroadcastLen when aborted runs age out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-aborted";
    deps.chatRunState.abortedRuns.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.abortedRuns.has(runId)).toBe(false);
    expect(deps.chatRunBuffers.has(runId)).toBe(false);
    expect(deps.chatDeltaSentAt.has(runId)).toBe(false);
    expect(deps.chatDeltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });
});
