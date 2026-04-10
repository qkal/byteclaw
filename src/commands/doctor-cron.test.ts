import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as noteModule from "../terminal/note.js";
import { maybeRepairLegacyCronStore } from "./doctor-cron.js";

let tempRoot: string | null = null;

async function makeTempStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  return path.join(tempRoot, "cron", "jobs.json");
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempRoot) {
    await fs.rm(tempRoot, { force: true, recursive: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return {
    confirm: vi.fn().mockResolvedValue(confirmResult),
  };
}

function createCronConfig(storePath: string): OpenClawConfig {
  return {
    cron: {
      store: storePath,
      webhook: "https://example.invalid/cron-finished",
    },
  };
}

function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    schedule: { cron: "0 7 * * *", kind: "cron", tz: "UTC" },
    state: {},
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    ...overrides,
  };
}

async function writeCronStore(storePath: string, jobs: Record<string, unknown>[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        jobs,
        version: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("maybeRepairLegacyCronStore", () => {
  it("repairs legacy cron store fields and migrates notify fallback to webhook delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    const cfg = createCronConfig(storePath);

    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    const [job] = persisted.jobs;
    expect(job?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    expect(job?.notify).toBeUndefined();
    expect(job?.schedule).toMatchObject({
      expr: "0 7 * * *",
      kind: "cron",
      tz: "UTC",
    });
    expect(job?.delivery).toMatchObject({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
    expect(job?.payload).toMatchObject({
      kind: "systemEvent",
      text: "Morning brief",
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Legacy cron job storage detected"),
      "Cron",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cron store normalized"),
      "Doctor changes",
    );
  });

  it("warns instead of replacing announce delivery for notify fallback jobs", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          jobs: [
            {
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              delivery: { channel: "telegram", mode: "announce", to: "123" },
              id: "notify-and-announce",
              name: "Notify and announce",
              notify: true,
              payload: { kind: "agentTurn", message: "Status" },
              schedule: { everyMs: 60_000, kind: "every" },
              sessionTarget: "isolated",
              state: {},
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              wakeMode: "now",
            },
          ],
          version: 1,
        },
        null,
        2,
      ),
      "utf8",
    );

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: { nonInteractive: true },
      prompter: makePrompter(true),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    expect(persisted.jobs[0]?.notify).toBe(true);
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining('uses legacy notify fallback alongside delivery mode "announce"'),
      "Doctor warnings",
    );
  });

  it("does not auto-repair in non-interactive mode without explicit repair approval", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    const prompter = makePrompter(false);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: { nonInteractive: true },
      prompter,
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    expect(prompter.confirm).toHaveBeenCalledWith({
      initialValue: true,
      message: "Repair legacy cron jobs now?",
    });
    expect(persisted.jobs[0]?.jobId).toBe("legacy-job");
    expect(persisted.jobs[0]?.notify).toBe(true);
    expect(noteSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Cron store normalized"),
      "Doctor changes",
    );
  });

  it("migrates notify fallback none delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          jobs: [
            {
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              delivery: { mode: "none", to: "123456789" },
              id: "notify-none",
              name: "Notify none",
              notify: true,
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              schedule: { everyMs: 60_000, kind: "every" },
              state: {},
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
            },
          ],
          version: 1,
        },
        null,
        2,
      ),
      "utf8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    expect(persisted.jobs[0]?.notify).toBeUndefined();
    expect(persisted.jobs[0]?.delivery).toMatchObject({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("repairs legacy root delivery threadId hints into delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        channel: " telegram ",
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        enabled: true,
        id: "legacy-thread-hint",
        name: "Legacy thread hint",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        schedule: { cron: "0 7 * * *", kind: "cron", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        threadId: " 99 ",
        to: "-1001234567890",
        updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
        wakeMode: "now",
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    expect(persisted.jobs[0]?.channel).toBeUndefined();
    expect(persisted.jobs[0]?.to).toBeUndefined();
    expect(persisted.jobs[0]?.threadId).toBeUndefined();
    expect(persisted.jobs[0]?.delivery).toMatchObject({
      channel: "telegram",
      mode: "announce",
      threadId: "99",
      to: "-1001234567890",
    });
  });
});
