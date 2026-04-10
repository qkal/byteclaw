import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { writeCronStoreSnapshot } from "./service.test-harness.js";

const noopLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

interface IsolatedRunResult {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    cleanup: async () => {
      // On macOS, teardown can race with trailing async fs writes and leave
      // Transient ENOTEMPTY/EBUSY errors; let fs.rm handle retries natively.
      try {
        await fs.rm(dir, {
          force: true,
          maxRetries: 10,
          recursive: true,
          retryDelay: 10,
        });
      } catch {
        await fs.rm(dir, { force: true, recursive: true });
      }
    },
    storePath: path.join(dir, "cron", "jobs.json"),
  };
}

function createDeferredIsolatedRun() {
  let resolveRun: ((value: IsolatedRunResult) => void) | undefined;
  let resolveRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    resolveRunStarted = resolve;
  });
  const runIsolatedAgentJob = vi.fn(async () => {
    resolveRunStarted?.();
    return await new Promise<IsolatedRunResult>((resolve) => {
      resolveRun = resolve;
    });
  });
  return {
    completeRun: (result: IsolatedRunResult) => {
      resolveRun?.(result);
    },
    runIsolatedAgentJob,
    runStarted,
  };
}

describe("CronService read ops while job is running", () => {
  it("keeps list and status responsive during a long isolated run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    let resolveFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      onEvent: (evt) => {
        if (evt.action === "finished" && evt.status === "ok") {
          resolveFinished?.();
        }
      },
      requestHeartbeatNow,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      storePath: store.storePath,
    });

    try {
      await cron.start();

      // Schedule the job a second in the future; then jump time to trigger the tick.
      await cron.add({
        deleteAfterRun: false,
        delivery: { mode: "none" },
        enabled: true,
        name: "slow isolated",
        payload: { kind: "agentTurn", message: "long task" },
        schedule: {
          at: new Date("2025-12-13T00:00:01.000Z").toISOString(),
          kind: "at",
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      });

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      await isolatedRun.runStarted;
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(cron.list({ includeDisabled: true })).resolves.toBeTypeOf("object");
      await expect(cron.status()).resolves.toBeTypeOf("object");

      const running = await cron.list({ includeDisabled: true });
      expect(running[0]?.state.runningAtMs).toBeTypeOf("number");

      isolatedRun.completeRun({ status: "ok", summary: "done" });

      // Wait until the scheduler writes the result back to the store.
      await finished;
      // Ensure any trailing store writes have finished before cleanup.
      await cron.status();

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");

      // Ensure the scheduler loop has fully settled before deleting the store directory.
      const internal = cron as unknown as { state?: { running?: boolean } };
      for (let i = 0; i < 100; i += 1) {
        if (!internal.state?.running) {
          break;
        }
        await Promise.resolve();
      }
      expect(internal.state?.running).toBe(false);
    } finally {
      cron.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
      await store.cleanup();
    }
  });

  it("keeps list and status responsive during manual cron.run execution", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      requestHeartbeatNow,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      storePath: store.storePath,
    });

    try {
      await cron.start();
      const job = await cron.add({
        deleteAfterRun: false,
        delivery: { mode: "none" },
        enabled: true,
        name: "manual run isolation",
        payload: { kind: "agentTurn", message: "manual run" },
        schedule: {
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
          kind: "at",
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      });

      const runPromise = cron.run(job.id, "force");
      await isolatedRun.runStarted;

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during cron.run"),
      ).resolves.toBeTypeOf("object");
      await expect(withTimeout(cron.status(), 300, "cron.status during cron.run")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storePath: store.storePath }),
      );

      isolatedRun.completeRun({ status: "ok", summary: "manual done" });
      await expect(runPromise).resolves.toEqual({ ok: true, ran: true });

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");
      expect(completed[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("keeps list and status responsive during startup catch-up runs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await writeCronStoreSnapshot({
      jobs: [
        {
          createdAtMs: nowMs - 86_400_000,
          delivery: { mode: "none" },
          enabled: true,
          id: "startup-catchup",
          name: "startup catch-up",
          payload: { kind: "agentTurn", message: "startup replay" },
          schedule: { at: new Date(nowMs - 60_000).toISOString(), kind: "at" },
          sessionTarget: "isolated",
          state: { nextRunAtMs: nowMs - 60_000 },
          updatedAtMs: nowMs - 86_400_000,
          wakeMode: "next-heartbeat",
        },
      ],
      storePath: store.storePath,
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      nowMs: () => nowMs,
      requestHeartbeatNow,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      storePath: store.storePath,
    });

    try {
      const startPromise = cron.start();
      await isolatedRun.runStarted;
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during startup"),
      ).resolves.toBeTypeOf("object");
      await expect(withTimeout(cron.status(), 300, "cron.status during startup")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storePath: store.storePath }),
      );

      isolatedRun.completeRun({ status: "ok", summary: "done" });
      await startPromise;

      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
