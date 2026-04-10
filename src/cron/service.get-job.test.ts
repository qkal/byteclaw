import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-get-job-" });
installCronTestHooks({ logger });

function createCronService(storePath: string) {
  return new CronService({
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    log: logger,
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    storePath,
  });
}

describe("CronService.getJob", () => {
  it("returns added jobs and undefined for missing ids", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add({
        enabled: true,
        name: "lookup-test",
        payload: { kind: "systemEvent", text: "ping" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });

      expect(cron.getJob(added.id)?.id).toBe(added.id);
      expect(cron.getJob("missing-job-id")).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("preserves webhook delivery on create", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const webhookJob = await cron.add({
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
        enabled: true,
        name: "webhook-job",
        payload: { kind: "systemEvent", text: "ping" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      expect(cron.getJob(webhookJob.id)?.delivery).toEqual({
        mode: "webhook",
        to: "https://example.invalid/cron",
      });
    } finally {
      cron.stop();
    }
  });
});
