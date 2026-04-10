import { describe, expect, it } from "vitest";
import { applyJobPatch, createJob, recomputeNextRuns } from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import type { CronJob, CronJobPatch } from "./types.js";

function expectCronStaggerMs(job: CronJob, expected: number): void {
  expect(job.schedule.kind).toBe("cron");
  if (job.schedule.kind === "cron") {
    expect(job.schedule.staggerMs).toBe(expected);
  }
}

describe("applyJobPatch", () => {
  const createIsolatedAgentTurnJob = (
    id: string,
    delivery: CronJob["delivery"],
    overrides?: Partial<CronJob>,
  ): CronJob => {
    const now = Date.now();
    return {
      createdAtMs: now,
      delivery,
      enabled: true,
      id,
      name: id,
      payload: { kind: "agentTurn", message: "do it" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      state: {},
      updatedAtMs: now,
      wakeMode: "now",
      ...overrides,
    };
  };

  const switchToMainPatch = (): CronJobPatch => ({
    payload: { kind: "systemEvent", text: "ping" },
    sessionTarget: "main",
  });

  const createMainSystemEventJob = (id: string, delivery: CronJob["delivery"]): CronJob => createIsolatedAgentTurnJob(id, delivery, {
      payload: { kind: "systemEvent", text: "ping" },
      sessionTarget: "main",
    });

  it("clears delivery when switching to main session", () => {
    const job = createIsolatedAgentTurnJob("job-1", {
      channel: "telegram",
      mode: "announce",
      to: "123",
    });

    expect(() => applyJobPatch(job, switchToMainPatch())).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.payload.kind).toBe("systemEvent");
    expect(job.delivery).toBeUndefined();
  });

  it("keeps webhook delivery when switching to main session", () => {
    const job = createIsolatedAgentTurnJob("job-webhook", {
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    expect(() => applyJobPatch(job, switchToMainPatch())).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/cron" });
  });

  it("applies explicit delivery patches", () => {
    const job = createIsolatedAgentTurnJob("job-2", {
      channel: "telegram",
      mode: "announce",
      to: "123",
    });

    const patch: CronJobPatch = {
      delivery: {
        bestEffort: true,
        channel: "signal",
        mode: "none",
        to: "555",
      },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("do it");
    }
    expect(job.delivery).toEqual({
      bestEffort: true,
      channel: "signal",
      mode: "none",
      to: "555",
    });
  });

  it("applies explicit delivery patches for custom session targets", () => {
    const job = createIsolatedAgentTurnJob(
      "job-custom-session",
      {
        channel: "telegram",
        mode: "announce",
        to: "123",
      },
      { sessionTarget: "session:project-alpha" },
    );

    applyJobPatch(job, {
      delivery: { mode: "announce", to: "555" },
    });

    expect(job.delivery).toEqual({
      bestEffort: undefined,
      channel: "telegram",
      mode: "announce",
      to: "555",
    });
  });

  it("merges delivery.accountId from patch and preserves existing", () => {
    const job = createIsolatedAgentTurnJob("job-acct", {
      channel: "telegram",
      mode: "announce",
      to: "-100123",
    });

    applyJobPatch(job, { delivery: { accountId: " coordinator ", mode: "announce" } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.to).toBe("-100123");

    // Updating other fields preserves accountId
    applyJobPatch(job, { delivery: { mode: "announce", to: "-100999" } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.to).toBe("-100999");

    // Clearing accountId with empty string
    applyJobPatch(job, { delivery: { accountId: "", mode: "announce" } });
    expect(job.delivery?.accountId).toBeUndefined();
  });

  it("persists agentTurn payload.lightContext updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-light-context", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = {
      kind: "agentTurn",
      lightContext: true,
      message: "do it",
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        lightContext: false,
        message: "do it",
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.lightContext).toBe(false);
    }
  });

  it("persists agentTurn payload.fallbacks updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-fallbacks", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = {
      fallbacks: ["openrouter/gpt-4.1-mini"],
      kind: "agentTurn",
      message: "do it",
    };

    applyJobPatch(job, {
      payload: {
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
        kind: "agentTurn",
        message: "do it",
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.fallbacks).toEqual(["anthropic/claude-haiku-3-5", "openai/gpt-5"]);
    }
  });

  it("persists agentTurn payload.toolsAllow updates when editing existing jobs", () => {
    const job = createIsolatedAgentTurnJob("job-tools", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      toolsAllow: ["exec"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["read", "write"],
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.toolsAllow).toEqual(["read", "write"]);
    }
  });

  it("clears agentTurn payload.toolsAllow when patch requests null", () => {
    const job = createIsolatedAgentTurnJob("job-tools-clear", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = {
      kind: "agentTurn",
      message: "do it",
      toolsAllow: ["exec", "read"],
    };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: null,
      },
    });

    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.toolsAllow).toBeUndefined();
    }
  });

  it("applies payload.lightContext when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-light-context-switch", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        lightContext: true,
        message: "do it",
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.lightContext).toBe(true);
    }
  });

  it("carries payload.fallbacks when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-fallbacks-switch", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        fallbacks: ["anthropic/claude-haiku-3-5", "openai/gpt-5"],
        kind: "agentTurn",
        message: "do it",
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.fallbacks).toEqual(["anthropic/claude-haiku-3-5", "openai/gpt-5"]);
    }
  });

  it("carries payload.toolsAllow when replacing payload kind via patch", () => {
    const job = createIsolatedAgentTurnJob("job-tools-switch", {
      channel: "telegram",
      mode: "announce",
    });
    job.payload = { kind: "systemEvent", text: "ping" };

    applyJobPatch(job, {
      payload: {
        kind: "agentTurn",
        message: "do it",
        toolsAllow: ["exec", "read"],
      },
    });

    const payload = job.payload as CronJob["payload"];
    expect(payload.kind).toBe("agentTurn");
    if (payload.kind === "agentTurn") {
      expect(payload.toolsAllow).toEqual(["exec", "read"]);
    }
  });

  it.each([
    { name: "no delivery update", patch: { enabled: true } satisfies CronJobPatch },
    {
      name: "blank webhook target",
      patch: { delivery: { mode: "webhook", to: "" } } satisfies CronJobPatch,
    },
    {
      name: "non-http protocol",
      patch: {
        delivery: { mode: "webhook", to: "ftp://example.invalid" },
      } satisfies CronJobPatch,
    },
    {
      name: "invalid URL",
      patch: { delivery: { mode: "webhook", to: "not-a-url" } } satisfies CronJobPatch,
    },
  ] as const)("rejects invalid webhook delivery target URL: $name", ({ patch }) => {
    const expectedError = "cron webhook delivery requires delivery.to to be a valid http(s) URL";
    const job = createMainSystemEventJob("job-webhook-invalid", { mode: "webhook" });
    expect(() => applyJobPatch(job, patch)).toThrow(expectedError);
  });

  it("trims webhook delivery target URLs", () => {
    const job = createMainSystemEventJob("job-webhook-trim", {
      mode: "webhook",
      to: "https://example.invalid/original",
    });

    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "  https://example.invalid/trim  " } }),
    ).not.toThrow();
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/trim" });
  });

  it("rejects failureDestination on main jobs without webhook delivery mode", () => {
    const job = createMainSystemEventJob("job-main-failure-dest", {
      channel: "telegram",
      failureDestination: {
        channel: "telegram",
        mode: "announce",
        to: "999",
      },
      mode: "announce",
      to: "123",
    });

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  });

  it("validates and trims webhook failureDestination target URLs", () => {
    const expectedError =
      "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL";
    const job = createIsolatedAgentTurnJob("job-failure-webhook-target", {
      channel: "telegram",
      failureDestination: {
        mode: "webhook",
        to: "not-a-url",
      },
      mode: "announce",
      to: "123",
    });

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(expectedError);

    job.delivery = {
      channel: "telegram",
      failureDestination: {
        mode: "webhook",
        to: "  https://example.invalid/failure  ",
      },
      mode: "announce",
      to: "123",
    };
    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
    expect(job.delivery?.failureDestination?.to).toBe("https://example.invalid/failure");
  });

  it("preserves raw channel delivery targets for plugin-owned validation", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-invalid", {
      channel: "telegram",
      mode: "announce",
      to: "-10012345/6789",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
    expect(job.delivery?.to).toBe("-10012345/6789");
  });

  it.each([
    { name: "t.me URL", to: "https://t.me/mychannel" },
    { name: "t.me URL (no https)", to: "t.me/mychannel" },
    { name: "valid target (plain chat id)", to: "-1001234567890" },
    { name: "valid target (colon delimiter)", to: "-1001234567890:123" },
    { name: "valid target (topic marker)", to: "-1001234567890:topic:456" },
    { name: "@username", to: "@mybot" },
    { name: "without target", to: undefined },
  ] as const)("accepts Telegram delivery with $name", ({ to }) => {
    const job = createIsolatedAgentTurnJob("job-telegram-valid", {
      channel: "telegram",
      mode: "announce",
      ...(to ? { to } : {}),
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });
});

function createMockState(now: number, opts?: { defaultAgentId?: string }): CronServiceState {
  return {
    deps: {
      defaultAgentId: opts?.defaultAgentId,
      nowMs: () => now,
    },
  } as unknown as CronServiceState;
}

describe("createJob rejects sessionTarget main for non-default agents", () => {
  const now = Date.parse("2026-02-28T12:00:00.000Z");

  const mainJobInput = (agentId?: string) => ({
    enabled: true,
    name: "my-main-job",
    payload: { kind: "systemEvent" as const, text: "tick" },
    schedule: { everyMs: 60_000, kind: "every" as const },
    sessionTarget: "main" as const,
    wakeMode: "now" as const,
    ...(agentId !== undefined ? { agentId } : {}),
  });

  it.each([
    { agentId: undefined, defaultAgentId: "main", name: "default agent" },
    { agentId: "main", defaultAgentId: "main", name: "explicit default agent" },
    { agentId: "MAIN", defaultAgentId: "Main", name: "case-insensitive defaultAgentId match" },
  ] as const)("allows creating a main-session job for $name", ({ defaultAgentId, agentId }) => {
    const state = createMockState(now, { defaultAgentId });
    expect(() => createJob(state, mainJobInput(agentId))).not.toThrow();
  });

  it.each([
    { agentId: "custom-agent", defaultAgentId: "main", name: "non-default agentId" },
    { agentId: "custom-agent", defaultAgentId: undefined, name: "missing defaultAgentId" },
  ] as const)("rejects creating a main-session job for $name", ({ defaultAgentId, agentId }) => {
    const state = createMockState(now, defaultAgentId ? { defaultAgentId } : undefined);
    expect(() => createJob(state, mainJobInput(agentId))).toThrow(
      'cron: sessionTarget "main" is only valid for the default agent',
    );
  });

  it("allows isolated session job for non-default agents", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    expect(() =>
      createJob(state, {
        agentId: "custom-agent",
        enabled: true,
        name: "isolated-job",
        payload: { kind: "agentTurn", message: "do it" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "isolated",
        wakeMode: "now",
      }),
    ).not.toThrow();
  });

  it("rejects custom session targets with path separators", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    expect(() =>
      createJob(state, {
        enabled: true,
        name: "bad-custom-session",
        payload: { kind: "agentTurn", message: "hello" },
        schedule: { everyMs: 60_000, kind: "every" },
        sessionTarget: "session:../../outside",
        wakeMode: "now",
      }),
    ).toThrow("invalid cron sessionTarget session id");
  });

  it("rejects failureDestination on main jobs without webhook delivery mode", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    expect(() =>
      createJob(state, {
        ...mainJobInput("main"),
        delivery: {
          channel: "telegram",
          failureDestination: {
            channel: "signal",
            mode: "announce",
            to: "+15550001111",
          },
          mode: "announce",
          to: "123",
        },
      }),
    ).toThrow('cron channel delivery config is only supported for sessionTarget="isolated"');
  });
});

describe("applyJobPatch rejects sessionTarget main for non-default agents", () => {
  const now = Date.now();

  const createMainJob = (agentId?: string): CronJob => ({
    agentId,
    createdAtMs: now,
    enabled: true,
    id: "job-main-agent-check",
    name: "main-agent-check",
    payload: { kind: "systemEvent", text: "tick" },
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget: "main",
    state: {},
    updatedAtMs: now,
    wakeMode: "now",
  });

  it.each([
    { agentId: "custom-agent", name: "rejects patching agentId to non-default", shouldThrow: true },
    { agentId: "main", name: "allows patching agentId to the default agent", shouldThrow: false },
  ] as const)("$name on a main-session job", ({ agentId, shouldThrow }) => {
    const job = createMainJob();
    const patch = { agentId } as CronJobPatch;
    if (shouldThrow) {
      expect(() => applyJobPatch(job, patch, { defaultAgentId: "main" })).toThrow(
        'cron: sessionTarget "main" is only valid for the default agent',
      );
      return;
    }
    expect(() => applyJobPatch(job, patch, { defaultAgentId: "main" })).not.toThrow();
  });

  it("rejects patching to a custom session target with path separators", () => {
    const job = createMainJob();
    expect(() =>
      applyJobPatch(
        job,
        {
          payload: { kind: "agentTurn", message: "hello" },
          sessionTarget: "session:..\\outside",
        },
        { defaultAgentId: "main" },
      ),
    ).toThrow("invalid cron sessionTarget session id");
  });
});

describe("cron stagger defaults", () => {
  it("defaults top-of-hour cron jobs to 5m stagger", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      enabled: true,
      name: "hourly",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
    });

    expectCronStaggerMs(job, DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("keeps exact schedules when staggerMs is explicitly 0", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      enabled: true,
      name: "exact-hourly",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { expr: "0 * * * *", kind: "cron", staggerMs: 0, tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
    });

    expectCronStaggerMs(job, 0);
  });

  it("preserves existing stagger when editing cron expression without stagger", () => {
    const now = Date.now();
    const job: CronJob = {
      createdAtMs: now,
      enabled: true,
      id: "job-keep-stagger",
      name: "job-keep-stagger",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { expr: "0 * * * *", kind: "cron", staggerMs: 120_000, tz: "UTC" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: now,
      wakeMode: "now",
    };

    applyJobPatch(job, {
      schedule: { expr: "0 */2 * * *", kind: "cron", tz: "UTC" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.expr).toBe("0 */2 * * *");
      expect(job.schedule.staggerMs).toBe(120_000);
    }
  });

  it("applies default stagger when switching from every to top-of-hour cron", () => {
    const now = Date.now();
    const job: CronJob = {
      createdAtMs: now,
      enabled: true,
      id: "job-switch-cron",
      name: "job-switch-cron",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: now,
      wakeMode: "now",
    };

    applyJobPatch(job, {
      schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    }
  });
});

describe("createJob delivery defaults", () => {
  const now = Date.parse("2026-02-28T12:00:00.000Z");

  it('defaults delivery to { mode: "announce" } for isolated agentTurn jobs without explicit delivery', () => {
    const state = createMockState(now);
    const job = createJob(state, {
      enabled: true,
      name: "isolated-no-delivery",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("preserves explicit delivery for isolated agentTurn jobs", () => {
    const state = createMockState(now);
    const job = createJob(state, {
      delivery: { mode: "none" },
      enabled: true,
      name: "isolated-explicit-delivery",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
    expect(job.delivery).toEqual({ mode: "none" });
  });

  it("does not set delivery for main systemEvent jobs without explicit delivery", () => {
    const state = createMockState(now, { defaultAgentId: "main" });
    const job = createJob(state, {
      enabled: true,
      name: "main-no-delivery",
      payload: { kind: "systemEvent", text: "ping" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      wakeMode: "now",
    });
    expect(job.delivery).toBeUndefined();
  });
});

describe("recomputeNextRuns", () => {
  it("backfills missing every anchorMs for legacy loaded jobs", () => {
    const now = Date.parse("2026-03-01T12:00:00.000Z");
    const createdAtMs = now - 120_000;
    const job: CronJob = {
      createdAtMs,
      enabled: true,
      id: "legacy-every",
      name: "legacy-every",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: createdAtMs,
      wakeMode: "now",
    };
    const state = {
      ...createMockState(now),
      store: { jobs: [job], version: 1 as const },
    } as CronServiceState;

    expect(recomputeNextRuns(state)).toBe(true);
    expect(job.schedule.kind).toBe("every");
    if (job.schedule.kind === "every") {
      expect(job.schedule.anchorMs).toBe(createdAtMs);
    }
    expect(job.state.nextRunAtMs).toBe(now);
  });
});
