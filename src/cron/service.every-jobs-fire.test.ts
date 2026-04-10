import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("CronService interval/cron jobs fire on time", () => {
  const runLateTimerAndLoadJob = async ({
    cron,
    finished,
    jobId,
    firstDueAt,
  }: {
    cron: CronService;
    finished: { waitForOk: (id: string) => Promise<unknown> };
    jobId: string;
    firstDueAt: number;
  }) => {
    vi.setSystemTime(new Date(firstDueAt + 5));
    await vi.runOnlyPendingTimersAsync();
    await finished.waitForOk(jobId);
    const jobs = await cron.list({ includeDisabled: true });
    return jobs.find((current) => current.id === jobId);
  };

  const expectMainSystemEvent = (
    enqueueSystemEvent: ReturnType<typeof vi.fn>,
    expectedText: string,
  ) => {
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expectedText,
      expect.objectContaining({ agentId: undefined }),
    );
  };

  it("fires an every-type main job when the timer fires a few ms late", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      logger: noopLogger,
      storePath: store.storePath,
    });

    await cron.start();
    const job = await cron.add({
      enabled: true,
      name: "every 10s check",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { everyMs: 10_000, kind: "every" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:00:00.000Z") + 10_000);

    const updated = await runLateTimerAndLoadJob({
      cron,
      finished,
      firstDueAt,
      jobId: job.id,
    });
    expectMainSystemEvent(enqueueSystemEvent, "tick");
    expect(updated?.state.lastStatus).toBe("ok");
    // NextRunAtMs must advance by at least one full interval past the due time.
    expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(firstDueAt + 10_000);

    cron.stop();
    await store.cleanup();
  });

  it("fires a cron-expression job when the timer fires a few ms late", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      logger: noopLogger,
      storePath: store.storePath,
    });

    // Set time to just before a minute boundary.
    vi.setSystemTime(new Date("2025-12-13T00:00:59.000Z"));

    await cron.start();
    const job = await cron.add({
      enabled: true,
      name: "every minute check",
      payload: { kind: "systemEvent", text: "cron-tick" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const firstDueAt = job.state.nextRunAtMs!;

    const updated = await runLateTimerAndLoadJob({
      cron,
      finished,
      firstDueAt,
      jobId: job.id,
    });
    expectMainSystemEvent(enqueueSystemEvent, "cron-tick");
    expect(updated?.state.lastStatus).toBe("ok");
    // NextRunAtMs should be the next whole-minute boundary (60s later).
    expect(updated?.state.nextRunAtMs).toBe(firstDueAt + 60_000);

    cron.stop();
    await store.cleanup();
  });

  it("keeps legacy every jobs due while minute cron jobs recompute schedules", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await writeCronStoreSnapshot({
      jobs: [
        {
          createdAtMs: nowMs,
          enabled: true,
          id: "legacy-every",
          name: "legacy every",
          payload: { kind: "systemEvent", text: "sf-tick" },
          schedule: { everyMs: 120_000, kind: "every" },
          sessionTarget: "main",
          state: { nextRunAtMs: nowMs + 120_000 },
          updatedAtMs: nowMs,
          wakeMode: "now",
        },
        {
          createdAtMs: nowMs,
          enabled: true,
          id: "minute-cron",
          name: "minute cron",
          payload: { kind: "systemEvent", text: "minute-tick" },
          schedule: { expr: "* * * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: { nextRunAtMs: nowMs + 60_000 },
          updatedAtMs: nowMs,
          wakeMode: "now",
        },
      ],
      storePath: store.storePath,
    });

    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      storePath: store.storePath,
    });

    await cron.start();
    // Perf: a few recomputation cycles are enough to catch legacy "every" drift.
    for (let minute = 1; minute <= 3; minute++) {
      vi.setSystemTime(new Date(nowMs + minute * 60_000));
      const minuteRun = await cron.run("minute-cron", "force");
      expect(minuteRun).toEqual({ ok: true, ran: true });
    }

    // "every" cadence is 2m; verify it stays due at the 6-minute boundary.
    vi.setSystemTime(new Date(nowMs + 6 * 60_000));
    const sfRun = await cron.run("legacy-every", "due");
    expect(sfRun).toEqual({ ok: true, ran: true });

    const sfRuns = enqueueSystemEvent.mock.calls.filter((args) => args[0] === "sf-tick").length;
    const minuteRuns = enqueueSystemEvent.mock.calls.filter(
      (args) => args[0] === "minute-tick",
    ).length;
    expect(minuteRuns).toBeGreaterThan(0);
    expect(sfRuns).toBeGreaterThan(0);

    const jobs = await cron.list({ includeDisabled: true });
    const sfJob = jobs.find((job) => job.id === "legacy-every");
    expect(sfJob?.state.lastStatus).toBe("ok");
    expect(sfJob?.schedule.kind).toBe("every");
    expect(sfJob?.state.nextRunAtMs).toBe(nowMs + 8 * 60_000);

    cron.stop();
    await store.cleanup();
  });
});
