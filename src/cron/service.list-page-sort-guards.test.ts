import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { listPage } from "./service/ops.js";
import type { CronJob } from "./types.js";

function createBaseJob(overrides?: Partial<CronJob>): CronJob {
  return {
    createdAtMs: Date.parse("2026-02-27T15:00:00.000Z"),
    enabled: true,
    id: "job-1",
    name: "job",
    payload: { kind: "systemEvent", text: "tick" },
    schedule: { expr: "*/5 * * * *", kind: "cron", tz: "UTC" },
    sessionTarget: "main",
    state: { nextRunAtMs: Date.parse("2026-02-27T15:30:00.000Z") },
    updatedAtMs: Date.parse("2026-02-27T15:05:00.000Z"),
    wakeMode: "now",
    ...overrides,
  };
}

describe("cron listPage sort guards", () => {
  it("does not throw when sorting by name with malformed name fields", async () => {
    const jobs = [
      createBaseJob({ id: "job-a", name: undefined as unknown as string }),
      createBaseJob({ id: "job-b", name: "beta" }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "name", sortDir: "asc" });
    expect(page.jobs).toHaveLength(2);
  });

  it("does not throw when tie-break sorting encounters missing ids", async () => {
    const nextRunAtMs = Date.parse("2026-02-27T15:30:00.000Z");
    const jobs = [
      createBaseJob({
        id: undefined as unknown as string,
        name: "alpha",
        state: { nextRunAtMs },
      }),
      createBaseJob({
        id: undefined as unknown as string,
        name: "alpha",
        state: { nextRunAtMs },
      }),
    ];
    const state = createMockCronStateForJobs({ jobs });

    const page = await listPage(state, { sortBy: "nextRunAtMs", sortDir: "asc" });
    expect(page.jobs).toHaveLength(2);
  });
});
