import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  createRunningCronServiceState,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();

function createDueRecurringJob(params: {
  id: string;
  nowMs: number;
  nextRunAtMs: number;
}): CronJob {
  return {
    createdAtMs: params.nowMs,
    deleteAfterRun: false,
    delivery: { mode: "none" },
    enabled: true,
    id: params.id,
    name: params.id,
    payload: { kind: "agentTurn", message: "test" },
    schedule: { everyMs: 5 * 60_000, kind: "every" },
    sessionTarget: "isolated",
    state: { nextRunAtMs: params.nextRunAtMs },
    updatedAtMs: params.nowMs,
    wakeMode: "next-heartbeat",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CronService - timer re-arm when running (#12025)", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("re-arms the timer when onTimer is called while state.running is true", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");

    const state = createRunningCronServiceState({
      jobs: [
        createDueRecurringJob({
          id: "recurring-job",
          nextRunAtMs: now + 5 * 60_000,
          nowMs: now,
        }),
      ],
      log: noopLogger,
      nowMs: () => now,
      storePath: store.storePath,
    });

    // Before the fix in #12025, this would return without re-arming,
    // Silently killing the scheduler.
    await onTimer(state);

    // The timer must be re-armed so the scheduler continues ticking,
    // With a fixed 60s delay to avoid hot-looping.
    expect(state.timer).not.toBeNull();
    expect(timeoutSpy).toHaveBeenCalled();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);

    // State.running should still be true (onTimer bailed out, didn't
    // Touch it — the original caller's finally block handles that).
    expect(state.running).toBe(true);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });

  it("arms a watchdog timer while a timer tick is still executing", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          jobs: [
            createDueRecurringJob({
              id: "long-running-job",
              nextRunAtMs: now,
              nowMs: now,
            }),
          ],
          version: 1,
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => await deferredRun.promise),
      storePath: store.storePath,
    });

    let settled = false;
    const timerPromise = onTimer(state);
    void timerPromise.finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.running).toBe(true);
    expect(state.timer).not.toBeNull();

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;
    expect(state.running).toBe(false);

    timeoutSpy.mockRestore();
    await store.cleanup();
  });
});
