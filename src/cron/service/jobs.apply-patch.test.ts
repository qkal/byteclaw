import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { applyJobPatch } from "./jobs.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    createdAtMs: now,
    delivery: { channel: "telegram", mode: "announce", to: "-1001234567890" },
    enabled: true,
    id: "job-1",
    name: "test",
    payload: { kind: "agentTurn", message: "hello" },
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget: "isolated",
    state: {},
    updatedAtMs: now,
    wakeMode: "now",
    ...overrides,
  };
}

describe("applyJobPatch delivery merge", () => {
  it("threads explicit delivery threadId patches into delivery", () => {
    const job = makeJob();
    const patch = { delivery: { threadId: "99" } } as Parameters<typeof applyJobPatch>[1];

    applyJobPatch(job, patch);

    expect(job.delivery).toEqual({
      channel: "telegram",
      mode: "announce",
      threadId: "99",
      to: "-1001234567890",
    });
  });
});
