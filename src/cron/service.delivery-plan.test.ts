import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../channels/plugins/types.js";
import type { CronService} from "./service.js";
import type { CronServiceDeps } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-delivery-" });

type DeliveryMode = "none" | "announce";

interface DeliveryOverride {
  mode: DeliveryMode;
  channel?: ChannelId;
  to?: string;
}

async function withCronService(
  params: {
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (context: {
    cron: CronService;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  await withCronServiceForTest(
    {
      cronEnabled: false,
      logger: noopLogger,
      makeStorePath,
      runIsolatedAgentJob: params.runIsolatedAgentJob,
    },
    run,
  );
}

async function addIsolatedAgentTurnJob(
  cron: CronService,
  params: {
    name: string;
    wakeMode: "next-heartbeat" | "now";
    delivery?: DeliveryOverride;
  },
) {
  return cron.add({
    enabled: true,
    name: params.name,
    payload: {
      kind: "agentTurn",
      message: "hello",
    } as unknown as { kind: "agentTurn"; message: string },
    schedule: { anchorMs: Date.now(), everyMs: 60_000, kind: "every" },
    sessionTarget: "isolated",
    wakeMode: params.wakeMode,
    ...(params.delivery
      ? {
          delivery: params.delivery as unknown as {
            mode: DeliveryMode;
            channel?: string;
            to?: string;
          },
        }
      : {}),
  });
}

describe("CronService delivery plan consistency", () => {
  it("does not post isolated summary when delivery.mode=none", async () => {
    await withCronService({}, async ({ cron, enqueueSystemEvent }) => {
      const job = await addIsolatedAgentTurnJob(cron, {
        delivery: { mode: "none" },
        name: "delivery-off",
        wakeMode: "next-heartbeat",
      });

      const result = await cron.run(job.id, "force");
      expect(result).toEqual({ ok: true, ran: true });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    });
  });

  it("treats delivery object without mode as announce without reviving legacy relay fallback", async () => {
    await withCronService({}, async ({ cron, enqueueSystemEvent }) => {
      const job = await addIsolatedAgentTurnJob(cron, {
        delivery: { channel: "telegram", to: "123" } as DeliveryOverride,
        name: "partial-delivery",
        wakeMode: "next-heartbeat",
      });

      const result = await cron.run(job.id, "force");
      expect(result).toEqual({ ok: true, ran: true });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("unknown");
    });
  });

  it("does not enqueue duplicate relay when isolated run marks delivery handled", async () => {
    await withCronService(
      {
        runIsolatedAgentJob: vi.fn(async () => ({
          delivered: true,
          status: "ok" as const,
          summary: "done",
        })),
      },
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        const job = await addIsolatedAgentTurnJob(cron, {
          delivery: { channel: "telegram", to: "123" } as DeliveryOverride,
          name: "announce-delivered",
          wakeMode: "now",
        });

        const result = await cron.run(job.id, "force");
        expect(result).toEqual({ ok: true, ran: true });
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();
      },
    );
  });
});
