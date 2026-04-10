import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { findJobOrThrow } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: Record<string, unknown>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        jobs: [job],
        version: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createStoreTestState(storePath: string) {
  return createCronServiceState({
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    storePath,
  });
}

describe("cron service store seam coverage", () => {
  it("loads stored jobs, recomputes next runs, and does not rewrite the store on load", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      createdAtMs: STORE_TEST_NOW - 60_000,
      delivery: { channel: "telegram", mode: "announce", to: "123" },
      enabled: true,
      id: "modern-job",
      name: "modern job",
      payload: { kind: "agentTurn", message: "ping" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      state: {},
      updatedAtMs: STORE_TEST_NOW - 60_000,
      wakeMode: "now",
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    expect(job).toBeDefined();
    expect(job?.sessionTarget).toBe("isolated");
    expect(job?.payload.kind).toBe("agentTurn");
    if (job?.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("ping");
    }
    expect(job?.delivery).toMatchObject({
      channel: "telegram",
      mode: "announce",
      to: "123",
    });
    expect(job?.state.nextRunAtMs).toBe(STORE_TEST_NOW);

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    const persistedJob = persisted.jobs[0];
    expect(persistedJob?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    expect(persistedJob?.delivery).toMatchObject({
      channel: "telegram",
      mode: "announce",
      to: "123",
    });

    const firstMtime = state.storeFileMtimeMs;
    expect(typeof firstMtime).toBe("number");

    await persist(state);
    expect(typeof state.storeFileMtimeMs).toBe("number");
    expect((state.storeFileMtimeMs ?? 0) >= (firstMtime ?? 0)).toBe(true);
  });

  it("normalizes jobId-only jobs in memory so scheduler lookups resolve by stable id", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      createdAtMs: STORE_TEST_NOW - 60_000,
      enabled: true,
      jobId: "repro-stable-id",
      name: "handed",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: STORE_TEST_NOW - 60_000,
      wakeMode: "now",
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "repro-stable-id", storePath }),
      expect.stringContaining("legacy jobId"),
    );

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();

    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    expect(raw.jobs[0]?.jobId).toBe("repro-stable-id");
    expect(raw.jobs[0]?.id).toBeUndefined();
  });
});
