import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-" });
installCronTestHooks({
  baseTimeIso: "2025-12-13T00:00:00.000Z",
  logger: noopLogger,
});

describe("CronService", () => {
  it("avoids duplicate runs when two services share a store", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));

    const cronA = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    await cronA.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cronA.add({
      enabled: true,
      name: "shared store job",
      payload: { kind: "systemEvent", text: "hello" },
      schedule: { at: new Date(atMs).toISOString(), kind: "at" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const cronB = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    await cronB.start();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await cronA.status();
    await cronB.status();

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);

    cronA.stop();
    cronB.stop();
    await store.cleanup();
  });
});
