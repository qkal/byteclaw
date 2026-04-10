import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-heartbeat-ok-suppressed",
});
type CronServiceParams = ConstructorParameters<typeof CronService>[0];

function createDueIsolatedAnnounceJob(params: {
  id: string;
  message: string;
  now: number;
}): CronJob {
  return {
    createdAtMs: params.now - 10_000,
    delivery: { mode: "announce" },
    enabled: true,
    id: params.id,
    name: params.id,
    payload: { kind: "agentTurn", message: params.message },
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget: "isolated",
    state: { nextRunAtMs: params.now - 1 },
    updatedAtMs: params.now - 10_000,
    wakeMode: "now",
  };
}

function createCronServiceForSummary(params: {
  storePath: string;
  summary: string;
  enqueueSystemEvent: CronServiceParams["enqueueSystemEvent"];
  requestHeartbeatNow: CronServiceParams["requestHeartbeatNow"];
}) {
  return new CronService({
    cronEnabled: true,
    enqueueSystemEvent: params.enqueueSystemEvent,
    log: logger,
    requestHeartbeatNow: params.requestHeartbeatNow,
    runHeartbeatOnce: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      delivered: false,
      deliveryAttempted: false,
      status: "ok" as const,
      summary: params.summary,
    })),
    storePath: params.storePath,
  });
}

async function runScheduledCron(cron: CronService): Promise<void> {
  await cron.start();
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(1000);
  cron.stop();
}

describe("cron isolated job HEARTBEAT_OK summary suppression (#32013)", () => {
  it("does not enqueue HEARTBEAT_OK as a system event to the main session", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createDueIsolatedAnnounceJob({
      id: "heartbeat-only-job",
      message: "Check if anything is new",
      now,
    });

    await writeCronStoreSnapshot({ jobs: [job], storePath });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = createCronServiceForSummary({
      enqueueSystemEvent,
      requestHeartbeatNow,
      storePath,
      summary: "HEARTBEAT_OK",
    });

    await runScheduledCron(cron);

    // HEARTBEAT_OK should NOT leak into the main session as a system event.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("does not revive legacy main-session relay for real cron summaries", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createDueIsolatedAnnounceJob({
      id: "real-summary-job",
      message: "Check weather",
      now,
    });

    await writeCronStoreSnapshot({ jobs: [job], storePath });

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = createCronServiceForSummary({
      enqueueSystemEvent,
      requestHeartbeatNow,
      storePath,
      summary: "Weather update: sunny, 72°F",
    });

    await runScheduledCron(cron);

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });
});
