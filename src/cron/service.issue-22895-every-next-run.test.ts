import { describe, expect, it } from "vitest";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import type { CronJob } from "./types.js";

const EVERY_30_MIN_MS = 30 * 60_000;
const ANCHOR_MS = Date.parse("2026-02-22T09:14:00.000Z");

function createEveryJob(state: CronJob["state"]): CronJob {
  return {
    createdAtMs: ANCHOR_MS,
    delivery: { mode: "none" },
    enabled: true,
    id: "issue-22895",
    name: "every-30-min",
    payload: { kind: "agentTurn", message: "check cadence" },
    schedule: { anchorMs: ANCHOR_MS, everyMs: EVERY_30_MIN_MS, kind: "every" },
    sessionTarget: "isolated",
    state,
    updatedAtMs: ANCHOR_MS,
    wakeMode: "next-heartbeat",
  };
}

describe("Cron issue #22895 interval scheduling", () => {
  it("uses lastRunAtMs cadence when the next interval is still in the future", () => {
    const nowMs = Date.parse("2026-02-22T10:10:00.000Z");
    const job = createEveryJob({
      lastRunAtMs: Date.parse("2026-02-22T10:04:00.000Z"),
    });

    const nextFromLast = computeJobNextRunAtMs(job, nowMs);
    const nextFromAnchor = computeJobNextRunAtMs(
      { ...job, state: { ...job.state, lastRunAtMs: undefined } },
      nowMs,
    );

    expect(nextFromLast).toBe(job.state.lastRunAtMs! + EVERY_30_MIN_MS);
    expect(nextFromAnchor).toBe(Date.parse("2026-02-22T10:14:00.000Z"));
    expect(nextFromLast).toBeGreaterThan(nextFromAnchor!);
  });

  it("falls back to anchor scheduling when lastRunAtMs cadence is already in the past", () => {
    const nowMs = Date.parse("2026-02-22T10:40:00.000Z");
    const job = createEveryJob({
      lastRunAtMs: Date.parse("2026-02-22T10:04:00.000Z"),
    });

    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBe(Date.parse("2026-02-22T10:44:00.000Z"));
  });
});
