import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

type CronServiceParams = ConstructorParameters<typeof CronService>[0];

const noopLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-failure-alert-"));
  return {
    cleanup: async () => {
      await fs.rm(dir, { force: true, recursive: true });
    },
    storePath: path.join(dir, "cron", "jobs.json"),
  };
}

function createFailureAlertCron(params: {
  storePath: string;
  cronConfig?: CronServiceParams["cronConfig"];
  runIsolatedAgentJob: NonNullable<CronServiceParams["runIsolatedAgentJob"]>;
  sendCronFailureAlert: NonNullable<CronServiceParams["sendCronFailureAlert"]>;
}) {
  return new CronService({
    cronConfig: params.cronConfig,
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    log: noopLogger,
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: params.runIsolatedAgentJob,
    sendCronFailureAlert: params.sendCronFailureAlert,
    storePath: params.storePath,
  });
}

describe("CronService failure alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("alerts after configured consecutive failures and honors cooldown", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      error: "wrong model id",
      status: "error" as const,
    }));

    const cron = createFailureAlertCron({
      cronConfig: {
        failureAlert: {
          after: 2,
          cooldownMs: 60_000,
          enabled: true,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
      storePath: store.storePath,
    });

    await cron.start();
    const job = await cron.add({
      delivery: { channel: "telegram", mode: "announce", to: "19098680" },
      enabled: true,
      name: "daily report",
      payload: { kind: "agentTurn", message: "run report" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        job: expect.objectContaining({ id: job.id }),
        text: expect.stringContaining('Cron job "daily report" failed 2 times'),
        to: "19098680",
      }),
    );

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(2);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Cron job "daily report" failed 4 times'),
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("supports per-job failure alert override when global alerts are disabled", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      error: "timeout",
      status: "error" as const,
    }));

    const cron = createFailureAlertCron({
      cronConfig: {
        failureAlert: {
          enabled: false,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
      storePath: store.storePath,
    });

    await cron.start();
    const job = await cron.add({
      enabled: true,
      failureAlert: {
        after: 1,
        channel: "telegram",
        cooldownMs: 1,
        to: "12345",
      },
      name: "job with override",
      payload: { kind: "agentTurn", message: "run report" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });

    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("respects per-job failureAlert=false and suppresses alerts", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      error: "auth error",
      status: "error" as const,
    }));

    const cron = createFailureAlertCron({
      cronConfig: {
        failureAlert: {
          after: 1,
          enabled: true,
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
      storePath: store.storePath,
    });

    await cron.start();
    const job = await cron.add({
      enabled: true,
      failureAlert: false,
      name: "disabled alert job",
      payload: { kind: "agentTurn", message: "run report" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });

    await cron.run(job.id, "force");
    await cron.run(job.id, "force");
    expect(sendCronFailureAlert).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("threads failure alert mode/accountId and skips best-effort jobs", async () => {
    const store = await makeStorePath();
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const runIsolatedAgentJob = vi.fn(async () => ({
      error: "temporary upstream error",
      status: "error" as const,
    }));

    const cron = createFailureAlertCron({
      cronConfig: {
        failureAlert: {
          accountId: "global-account",
          after: 1,
          enabled: true,
          mode: "webhook",
        },
      },
      runIsolatedAgentJob,
      sendCronFailureAlert,
      storePath: store.storePath,
    });

    await cron.start();
    const normalJob = await cron.add({
      delivery: { channel: "telegram", mode: "announce", to: "19098680" },
      enabled: true,
      name: "normal alert job",
      payload: { kind: "agentTurn", message: "run report" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });
    const bestEffortJob = await cron.add({
      delivery: {
        bestEffort: true,
        channel: "telegram",
        mode: "announce",
        to: "19098680",
      },
      enabled: true,
      name: "best effort alert job",
      payload: { kind: "agentTurn", message: "run report" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });

    await cron.run(normalJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "global-account",
        mode: "webhook",
        to: undefined,
      }),
    );

    await cron.run(bestEffortJob.id, "force");
    expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);

    cron.stop();
    await store.cleanup();
  });
});
