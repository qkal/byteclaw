import { describe, expect, it } from "vitest";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "../cron/stagger.js";
import { normalizeStoredCronJobs } from "./doctor-cron-store-migration.js";

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    agentId: undefined,
    createdAtMs: 1_700_000_000_000,
    deleteAfterRun: false,
    description: null,
    enabled: true,
    id: "job-legacy",
    name: "Legacy job",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    sessionTarget: "main",
    state: {},
    updatedAtMs: 1_700_000_000_000,
    wakeMode: "next-heartbeat",
    ...overrides,
  };
}

function normalizeOneJob(job: Record<string, unknown>) {
  const jobs = [job];
  const result = normalizeStoredCronJobs(jobs);
  return { job: jobs[0], result };
}

describe("normalizeStoredCronJobs", () => {
  it("normalizes legacy cron fields and reports migration issues", () => {
    const jobs = [
      {
        deliver: true,
        jobId: "legacy-job",
        message: "say hi",
        model: "openai/gpt-5.4",
        provider: " TeLeGrAm ",
        schedule: { cron: "*/5 * * * *", kind: "cron", tz: "UTC" },
        threadId: " 77 ",
        to: "12345",
      },
    ] as Record<string, unknown>[];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues).toMatchObject({
      jobId: 1,
      legacyScheduleCron: 1,
      legacyTopLevelDeliveryFields: 1,
      legacyTopLevelPayloadFields: 1,
    });

    const [job] = jobs;
    expect(job?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    expect(job?.schedule).toMatchObject({
      expr: "*/5 * * * *",
      kind: "cron",
      tz: "UTC",
    });
    expect(job?.message).toBeUndefined();
    expect(job?.provider).toBeUndefined();
    expect(job?.delivery).toMatchObject({
      channel: "telegram",
      mode: "announce",
      threadId: "77",
      to: "12345",
    });
    expect(job?.payload).toMatchObject({
      kind: "agentTurn",
      message: "say hi",
      model: "openai/gpt-5.4",
    });
  });

  it("normalizes payload provider alias into channel", () => {
    const jobs = [
      {
        id: "legacy-provider",
        payload: {
          kind: "agentTurn",
          message: "ping",
          provider: " Slack ",
        },
        schedule: { everyMs: 60_000, kind: "every" },
      },
    ] as Record<string, unknown>[];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadProvider).toBe(1);
    expect(jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      message: "ping",
    });
    const payload = jobs[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.provider).toBeUndefined();
    expect(jobs[0]?.delivery).toMatchObject({
      channel: "slack",
      mode: "announce",
    });
  });

  it("does not report legacyPayloadKind for already-normalized payload kinds", () => {
    const jobs = [
      {
        delivery: { mode: "announce" },
        enabled: true,
        id: "normalized-agent-turn",
        name: "normalized",
        payload: { kind: "agentTurn", message: "ping" },
        schedule: { anchorMs: 1, everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "now",
      },
    ] as Record<string, unknown>[];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(false);
    expect(result.issues.legacyPayloadKind).toBeUndefined();
  });

  it("normalizes whitespace-padded and non-canonical payload kinds", () => {
    const jobs = [
      {
        delivery: { mode: "announce" },
        enabled: true,
        id: "spaced-agent-turn",
        name: "normalized",
        payload: { kind: " agentTurn ", message: "ping" },
        schedule: { anchorMs: 1, everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "now",
      },
      {
        delivery: { mode: "announce" },
        enabled: true,
        id: "upper-system-event",
        name: "normalized",
        payload: { kind: "SYSTEMEVENT", text: "pong" },
        schedule: { anchorMs: 1, everyMs: 60_000, kind: "every" },
        sessionTarget: "main",
        state: {},
        wakeMode: "now",
      },
    ] as Record<string, unknown>[];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    expect(jobs[0]?.payload).toMatchObject({ kind: "agentTurn", message: "ping" });
    expect(jobs[1]?.payload).toMatchObject({ kind: "systemEvent", text: "pong" });
  });

  it("normalizes isolated legacy jobs without mutating runtime code paths", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-1",
        isolation: { postToMainPrefix: "Cron" },
        payload: {
          bestEffortDeliver: true,
          channel: "telegram",
          deliver: true,
          kind: "agentTurn",
          message: "hi",
          to: "7200373102",
        },
        schedule: { atMs: 1_700_000_000_000, kind: "at" },
        sessionKey: "  agent:main:discord:channel:ops  ",
        sessionTarget: "isolated",
      }),
    );

    expect(result.mutated).toBe(true);
    expect(job.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(job.delivery).toEqual({
      bestEffort: true,
      channel: "telegram",
      mode: "announce",
      to: "7200373102",
    });
    expect("isolation" in job).toBe(false);

    const payload = job.payload as Record<string, unknown>;
    expect(payload.deliver).toBeUndefined();
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.bestEffortDeliver).toBeUndefined();

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(schedule.atMs).toBeUndefined();
  });

  it("preserves stored custom session targets", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-custom-session",
        name: "Custom session",
        payload: {
          kind: "agentTurn",
          message: "hello",
        },
        schedule: { expr: "0 23 * * *", kind: "cron", tz: "UTC" },
        sessionTarget: "session:ProjectAlpha",
      }),
    );

    expect(job.sessionTarget).toBe("session:ProjectAlpha");
    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("adds anchorMs to legacy every schedules", () => {
    const createdAtMs = 1_700_000_000_000;
    const { job } = normalizeOneJob(
      makeLegacyJob({
        createdAtMs,
        id: "job-every-legacy",
        name: "Legacy every",
        schedule: { everyMs: 120_000, kind: "every" },
        updatedAtMs: createdAtMs,
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("every");
    expect(schedule.anchorMs).toBe(createdAtMs);
  });

  it("adds default staggerMs to legacy recurring top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-legacy",
        name: "Legacy cron",
        schedule: { expr: "0 */2 * * *", kind: "cron", tz: "UTC" },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("adds default staggerMs to legacy 6-field top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-seconds-legacy",
        name: "Legacy cron seconds",
        schedule: { expr: "0 0 */3 * * *", kind: "cron", tz: "UTC" },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("removes invalid legacy staggerMs from non top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-minute-legacy",
        name: "Legacy minute cron",
        schedule: {
          expr: "17 * * * *",
          kind: "cron",
          staggerMs: "bogus",
          tz: "UTC",
        },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBeUndefined();
  });

  it("migrates legacy string schedules and command-only payloads (#18445)", () => {
    const { job, result } = normalizeOneJob({
      command: "bash /tmp/imessage-refresh.sh",
      createdAtMs: 1_700_000_000_000,
      enabled: true,
      id: "imessage-refresh",
      name: "iMessage Refresh",
      schedule: "0 */2 * * *",
      state: {},
      timeout: 120,
      updatedAtMs: 1_700_000_000_000,
    });

    expect(result.mutated).toBe(true);
    expect(job.schedule).toEqual(
      expect.objectContaining({
        expr: "0 */2 * * *",
        kind: "cron",
      }),
    );
    expect(job.sessionTarget).toBe("main");
    expect(job.wakeMode).toBe("now");
    expect(job.payload).toEqual({
      kind: "systemEvent",
      text: "bash /tmp/imessage-refresh.sh",
    });
    expect("command" in job).toBe(false);
    expect("timeout" in job).toBe(false);
  });
});
