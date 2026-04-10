import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createNoopLogger,
  installCronTestHooks,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-load-"));
  return {
    dir,
    storePath: path.join(dir, "cron", "jobs.json"),
  };
}

describe("CronService store load", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (!tempDir) {
      return;
    }
    await fs.rm(tempDir, { force: true, recursive: true });
    tempDir = null;
  });

  it("skips invalid main jobs with agentTurn payloads loaded from disk", async () => {
    const { dir, storePath } = await makeStorePath();
    tempDir = dir;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const job = {
      createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      enabled: true,
      id: "job-1",
      name: "bad",
      payload: { kind: "agentTurn", message: "bad" },
      schedule: { at: "2025-12-13T00:00:01.000Z", kind: "at" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
      wakeMode: "now",
    } satisfies CronJob;

    await writeCronStoreSnapshot({ jobs: [job], storePath });

    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      storePath,
    });

    await cron.start();
    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await cron.run("job-1", "due");

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main cron jobs require payload\.kind/i);

    cron.stop();
  });
});
