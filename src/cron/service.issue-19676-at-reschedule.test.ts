import { describe, expect, it } from "vitest";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import type { CronJob } from "./types.js";

const ORIGINAL_AT_MS = Date.parse("2026-02-22T10:00:00.000Z");
const LAST_RUN_AT_MS = Date.parse("2026-02-22T10:00:05.000Z"); // Ran shortly after scheduled time
const RESCHEDULED_AT_MS = Date.parse("2026-02-22T12:00:00.000Z"); // Rescheduled to 2 hours later

function createAtJob(
  overrides: { state?: CronJob["state"]; schedule?: CronJob["schedule"] } = {},
): CronJob {
  return {
    createdAtMs: ORIGINAL_AT_MS - 60_000,
    delivery: { mode: "none" },
    enabled: true,
    id: "issue-19676",
    name: "one-shot-reminder",
    payload: { kind: "agentTurn", message: "reminder" },
    schedule: overrides.schedule ?? { at: new Date(ORIGINAL_AT_MS).toISOString(), kind: "at" },
    sessionTarget: "isolated",
    state: { ...overrides.state },
    updatedAtMs: ORIGINAL_AT_MS - 60_000,
    wakeMode: "next-heartbeat",
  };
}

describe("Cron issue #19676 at-job reschedule", () => {
  it("returns undefined for a completed one-shot job that has not been rescheduled", () => {
    const job = createAtJob({
      state: { lastRunAtMs: LAST_RUN_AT_MS, lastStatus: "ok" },
    });
    const nowMs = LAST_RUN_AT_MS + 1000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBeUndefined();
  });

  it("returns the new atMs when a completed one-shot job is rescheduled to a future time", () => {
    const job = createAtJob({
      schedule: { at: new Date(RESCHEDULED_AT_MS).toISOString(), kind: "at" },
      state: { lastRunAtMs: LAST_RUN_AT_MS, lastStatus: "ok" },
    });
    const nowMs = LAST_RUN_AT_MS + 1000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBe(RESCHEDULED_AT_MS);
  });

  it("returns the new atMs when rescheduled via legacy numeric atMs field", () => {
    const job = createAtJob({
      state: { lastRunAtMs: LAST_RUN_AT_MS, lastStatus: "ok" },
    });
    // Simulate legacy numeric atMs field on the schedule object.
    const schedule = job.schedule as { kind: "at"; atMs?: number };
    schedule.atMs = RESCHEDULED_AT_MS;
    const nowMs = LAST_RUN_AT_MS + 1000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBe(RESCHEDULED_AT_MS);
  });

  it("returns undefined when rescheduled to a time before the last run", () => {
    const beforeLastRun = LAST_RUN_AT_MS - 60_000;
    const job = createAtJob({
      schedule: { at: new Date(beforeLastRun).toISOString(), kind: "at" },
      state: { lastRunAtMs: LAST_RUN_AT_MS, lastStatus: "ok" },
    });
    const nowMs = LAST_RUN_AT_MS + 1000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBeUndefined();
  });

  it("still returns atMs for a job that has never run", () => {
    const job = createAtJob();
    const nowMs = ORIGINAL_AT_MS - 60_000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBe(ORIGINAL_AT_MS);
  });

  it("still returns atMs for a job whose last status is error", () => {
    const job = createAtJob({
      state: { lastRunAtMs: LAST_RUN_AT_MS, lastStatus: "error" },
    });
    const nowMs = LAST_RUN_AT_MS + 1000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBe(ORIGINAL_AT_MS);
  });

  it("returns undefined for a disabled job even if rescheduled", () => {
    const job = createAtJob({
      schedule: { at: new Date(RESCHEDULED_AT_MS).toISOString(), kind: "at" },
      state: { lastRunAtMs: LAST_RUN_AT_MS, lastStatus: "ok" },
    });
    job.enabled = false;
    const nowMs = LAST_RUN_AT_MS + 1000;
    expect(computeJobNextRunAtMs(job, nowMs)).toBeUndefined();
  });
});
