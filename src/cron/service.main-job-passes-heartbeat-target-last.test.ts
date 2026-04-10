import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-heartbeat-target",
});

type RunHeartbeatOnce = NonNullable<
  ConstructorParameters<typeof CronService>[0]["runHeartbeatOnce"]
>;

describe("cron main job passes heartbeat target=last", () => {
  function createMainCronJob(params: {
    now: number;
    id: string;
    wakeMode: CronJob["wakeMode"];
  }): CronJob {
    return {
      createdAtMs: params.now - 10_000,
      enabled: true,
      id: params.id,
      name: params.id,
      payload: { kind: "systemEvent", text: "Check in" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      state: { nextRunAtMs: params.now - 1 },
      updatedAtMs: params.now - 10_000,
      wakeMode: params.wakeMode,
    };
  }

  function createCronWithSpies(params: { storePath: string; runHeartbeatOnce: RunHeartbeatOnce }) {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: logger,
      requestHeartbeatNow,
      runHeartbeatOnce: params.runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      storePath: params.storePath,
    });
    return { cron, requestHeartbeatNow };
  }

  async function runSingleTick(cron: CronService) {
    await cron.start();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000);
    cron.stop();
  }

  it("should pass heartbeat.target=last to runHeartbeatOnce for wakeMode=now main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      id: "test-main-delivery",
      now,
      wakeMode: "now",
    });

    await writeCronStoreSnapshot({ jobs: [job], storePath });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      durationMs: 50,
      status: "ran" as const,
    }));

    const { cron } = createCronWithSpies({
      runHeartbeatOnce,
      storePath,
    });

    await runSingleTick(cron);

    // RunHeartbeatOnce should have been called
    expect(runHeartbeatOnce).toHaveBeenCalled();

    // The heartbeat config passed should include target: "last" so the
    // Heartbeat runner delivers the response to the last active channel.
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.heartbeat).toBeDefined();
    expect(callArgs?.heartbeat?.target).toBe("last");
  });

  it("should not pass heartbeat target for wakeMode=next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      id: "test-next-heartbeat",
      now,
      wakeMode: "next-heartbeat",
    });

    await writeCronStoreSnapshot({ jobs: [job], storePath });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      durationMs: 50,
      status: "ran" as const,
    }));

    const { cron, requestHeartbeatNow } = createCronWithSpies({
      runHeartbeatOnce,
      storePath,
    });

    await runSingleTick(cron);

    // WakeMode=next-heartbeat uses requestHeartbeatNow, not runHeartbeatOnce
    expect(requestHeartbeatNow).toHaveBeenCalled();
    // RunHeartbeatOnce should NOT have been called for next-heartbeat mode
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
  });
});
