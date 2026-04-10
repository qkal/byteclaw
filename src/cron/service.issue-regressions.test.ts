import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  noopLogger,
  setupCronIssueRegressionFixtures,
  startCronForStore,
  topOfHourOffsetMs,
  writeCronStoreSnapshot,
} from "./service.issue-regressions.test-helpers.js";
import { CronService } from "./service.js";
import type { CronJob, CronJobState } from "./types.js";

describe("Cron issue regressions", () => {
  const cronIssueRegressionFixtures = setupCronIssueRegressionFixtures();

  it("covers schedule updates and payload patching", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({
      cronEnabled: false,
      storePath: store.storePath,
    });

    const created = await cron.add({
      enabled: true,
      name: "hourly",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });
    const offsetMs = topOfHourOffsetMs(created.id);
    expect(created.state.nextRunAtMs).toBe(Date.parse("2026-02-06T11:00:00.000Z") + offsetMs);

    const updated = await cron.update(created.id, {
      schedule: { expr: "0 */2 * * *", kind: "cron", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBe(Date.parse("2026-02-06T12:00:00.000Z") + offsetMs);

    const unsafeToggle = await cron.add({
      enabled: true,
      name: "unsafe toggle",
      payload: { kind: "agentTurn", message: "hi" },
      schedule: { anchorMs: Date.now(), everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });

    const patched = await cron.update(unsafeToggle.id, {
      payload: { allowUnsafeExternalContent: true, kind: "agentTurn" },
    });

    expect(patched.payload.kind).toBe("agentTurn");
    if (patched.payload.kind === "agentTurn") {
      expect(patched.payload.allowUnsafeExternalContent).toBe(true);
      expect(patched.payload.message).toBe("hi");
    }

    cron.stop();
  });

  it("repairs isolated every jobs missing createdAtMs and sets nextWakeAtMs", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    await writeCronStoreSnapshot(store.storePath, [
      {
        agentId: "feature-dev_planner",
        enabled: true,
        id: "legacy-isolated",
        name: "legacy isolated",
        payload: { kind: "agentTurn", message: "poll workflow queue" },
        schedule: { everyMs: 300_000, kind: "every" },
        sessionKey: "agent:main:main",
        sessionTarget: "isolated",
        state: {},
        wakeMode: "now",
      },
    ]);

    const cron = new CronService({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      storePath: store.storePath,
    });
    await cron.start();

    const status = await cron.status();
    const jobs = await cron.list({ includeDisabled: true });
    const isolated = jobs.find((job) => job.id === "legacy-isolated");
    expect(Number.isFinite(isolated?.state.nextRunAtMs)).toBe(true);
    expect(Number.isFinite(status.nextWakeAtMs)).toBe(true);

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
      jobs: { id: string; state?: { nextRunAtMs?: number | null } }[];
    };
    const persistedIsolated = persisted.jobs.find((job) => job.id === "legacy-isolated");
    expect(typeof persistedIsolated?.state?.nextRunAtMs).toBe("number");
    expect(Number.isFinite(persistedIsolated?.state?.nextRunAtMs)).toBe(true);

    cron.stop();
  });

  it("does not rewrite unchanged stores during startup", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T11:00:00.000Z");
    await writeCronStoreSnapshot(store.storePath, [
      {
        createdAtMs: scheduledAt - 60_000,
        enabled: true,
        id: "startup-stable",
        name: "startup stable",
        payload: { kind: "systemEvent", text: "stable" },
        schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
        sessionTarget: "main",
        state: { nextRunAtMs: scheduledAt },
        updatedAtMs: scheduledAt - 60_000,
        wakeMode: "next-heartbeat",
      },
    ]);
    const before = await fs.readFile(store.storePath, "utf8");

    const cron = await startCronForStore({
      cronEnabled: true,
      storePath: store.storePath,
    });
    const after = await fs.readFile(store.storePath, "utf8");

    expect(after).toBe(before);
    cron.stop();
  });

  it("repairs missing nextRunAtMs on non-schedule updates without touching other jobs", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const cron = await startCronForStore({ cronEnabled: false, storePath: store.storePath });

    const created = await cron.add({
      enabled: true,
      name: "repair-target",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });
    const updated = await cron.update(created.id, {
      payload: { kind: "systemEvent", text: "tick-2" },
      state: { nextRunAtMs: undefined },
    });

    expect(updated.payload.kind).toBe("systemEvent");
    expect(typeof updated.state.nextRunAtMs).toBe("number");
    expect(updated.state.nextRunAtMs).toBe(created.state.nextRunAtMs);

    cron.stop();
  });

  it("does not advance unrelated due jobs when updating another job", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    vi.setSystemTime(now);
    const cron = await startCronForStore({ cronEnabled: false, storePath: store.storePath });

    const dueJob = await cron.add({
      enabled: true,
      name: "due-preserved",
      payload: { kind: "systemEvent", text: "due-preserved" },
      schedule: { anchorMs: now, everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });
    const otherJob = await cron.add({
      enabled: true,
      name: "other-job",
      payload: { kind: "systemEvent", text: "other" },
      schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const originalDueNextRunAtMs = dueJob.state.nextRunAtMs;
    expect(typeof originalDueNextRunAtMs).toBe("number");

    vi.setSystemTime(now + 5 * 60_000);

    await cron.update(otherJob.id, {
      payload: { kind: "systemEvent", text: "other-updated" },
    });

    const storeData = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
      jobs: { id: string; state?: { nextRunAtMs?: number } }[];
    };
    const persistedDueJob = storeData.jobs.find((job) => job.id === dueJob.id);
    expect(persistedDueJob?.state?.nextRunAtMs).toBe(originalDueNextRunAtMs);

    cron.stop();
  });

  it("treats persisted jobs with missing enabled as enabled during update()", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    await writeCronStoreSnapshot(store.storePath, [
      {
        createdAtMs: now - 60_000,
        id: "missing-enabled-update",
        name: "legacy missing enabled",
        payload: { kind: "systemEvent", text: "legacy" },
        schedule: { expr: "0 */2 * * *", kind: "cron", tz: "UTC" },
        sessionTarget: "main",
        state: {},
        updatedAtMs: now - 60_000,
        wakeMode: "next-heartbeat",
      },
    ]);

    const cron = await startCronForStore({ cronEnabled: false, storePath: store.storePath });

    const listed = await cron.list();
    expect(listed.some((job) => job.id === "missing-enabled-update")).toBe(true);

    const updated = await cron.update("missing-enabled-update", {
      schedule: { expr: "0 */3 * * *", kind: "cron", tz: "UTC" },
    });

    expect(updated.state.nextRunAtMs).toBeTypeOf("number");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);

    cron.stop();
  });

  it("treats persisted due jobs with missing enabled as runnable", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const dueAt = now - 30_000;
    await writeCronStoreSnapshot(store.storePath, [
      {
        createdAtMs: dueAt - 60_000,
        id: "missing-enabled-due",
        name: "legacy due job",
        payload: { kind: "systemEvent", text: "missing-enabled-due" },
        schedule: { at: new Date(dueAt).toISOString(), kind: "at" },
        sessionTarget: "main",
        state: { nextRunAtMs: dueAt },
        updatedAtMs: dueAt,
        wakeMode: "now",
      },
    ]);

    const enqueueSystemEvent = vi.fn();
    const cron = await startCronForStore({
      cronEnabled: false,
      enqueueSystemEvent,
      storePath: store.storePath,
    });

    const result = await cron.run("missing-enabled-due", "due");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "missing-enabled-due",
      expect.objectContaining({ agentId: undefined }),
    );

    cron.stop();
  });

  it("keeps telegram delivery target writeback after manual cron.run", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const originalTarget = "https://t.me/obviyus";
    const rewrittenTarget = "-10012345/6789";
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      const raw = await fs.readFile(store.storePath, "utf8");
      const persisted = JSON.parse(raw) as { version: number; jobs: CronJob[] };
      const targetJob = persisted.jobs.find((job) => job.id === params.job.id);
      if (targetJob?.delivery?.channel === "telegram") {
        targetJob.delivery.to = rewrittenTarget;
      }
      await fs.writeFile(store.storePath, JSON.stringify(persisted), "utf8");
      return { delivered: true, status: "ok" as const, summary: "done" };
    });

    const cron = await startCronForStore({
      cronEnabled: false,
      runIsolatedAgentJob,
      storePath: store.storePath,
    });
    const job = await cron.add({
      delivery: {
        channel: "telegram",
        mode: "announce",
        to: originalTarget,
      },
      enabled: true,
      name: "manual-writeback",
      payload: { kind: "agentTurn", message: "test" },
      schedule: { anchorMs: Date.now(), everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });

    const persisted = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const persistedJob = persisted.jobs.find((entry) => entry.id === job.id);
    expect(persistedJob?.delivery?.to).toBe(rewrittenTarget);
    expect(persistedJob?.state.lastStatus).toBe("ok");
    expect(persistedJob?.state.lastDelivered).toBe(true);

    cron.stop();
  });

  it("#13845: one-shot jobs with terminal statuses do not re-fire on restart", async () => {
    const store = cronIssueRegressionFixtures.makeStorePath();
    const pastAt = Date.parse("2026-02-06T09:00:00.000Z");
    const baseJob = {
      createdAtMs: pastAt - 60_000,
      deleteAfterRun: true,
      enabled: true,
      name: "reminder",
      payload: { kind: "systemEvent", text: "⏰ Reminder" },
      schedule: { at: new Date(pastAt).toISOString(), kind: "at" },
      sessionTarget: "main",
      updatedAtMs: pastAt,
      wakeMode: "now",
    } as const;
    const terminalStates: { id: string; state: CronJobState }[] = [
      {
        id: "oneshot-skipped",
        state: {
          lastRunAtMs: pastAt,
          lastStatus: "skipped",
          nextRunAtMs: pastAt,
        },
      },
      {
        id: "oneshot-errored",
        state: {
          lastError: "heartbeat failed",
          lastRunAtMs: pastAt,
          lastStatus: "error",
          nextRunAtMs: pastAt,
        },
      },
    ];
    for (const { id, state } of terminalStates) {
      const job: CronJob = { id, ...baseJob, state };
      await fs.writeFile(store.storePath, JSON.stringify({ jobs: [job], version: 1 }), "utf8");
      const enqueueSystemEvent = vi.fn();
      const cron = await startCronForStore({
        enqueueSystemEvent,
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
        storePath: store.storePath,
      });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      cron.stop();
    }
  });
});
