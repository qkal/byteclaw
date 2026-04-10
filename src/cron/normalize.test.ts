import { describe, expect, it } from "vitest";
import { validateCronAddParams, validateCronUpdateParams } from "../gateway/protocol/index.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";

function expectNormalizedAtSchedule(scheduleInput: Record<string, unknown>) {
  const normalized = normalizeCronJobCreate({
    enabled: true,
    name: "iso schedule",
    payload: {
      kind: "systemEvent",
      text: "hi",
    },
    schedule: scheduleInput,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
  }) as unknown as Record<string, unknown>;

  const schedule = normalized.schedule as Record<string, unknown>;
  expect(schedule.kind).toBe("at");
  expect(schedule.at).toBe(new Date(Date.parse("2026-01-12T18:00:00Z")).toISOString());
}

function expectAnnounceDeliveryTarget(
  delivery: Record<string, unknown>,
  params: { channel: string; to: string },
): void {
  expect(delivery.mode).toBe("announce");
  expect(delivery.channel).toBe(params.channel);
  expect(delivery.to).toBe(params.to);
}

function expectPayloadDeliveryHintsCleared(payload: Record<string, unknown>): void {
  expect(payload.channel).toBeUndefined();
  expect(payload.deliver).toBeUndefined();
  expect(payload.to).toBeUndefined();
  expect(payload.threadId).toBeUndefined();
  expect(payload.bestEffortDeliver).toBeUndefined();
  expect(payload.provider).toBeUndefined();
}

function normalizeIsolatedAgentTurnCreateJob(params: {
  name: string;
  payload?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
}): Record<string, unknown> {
  return normalizeCronJobCreate({
    enabled: true,
    name: params.name,
    payload: {
      kind: "agentTurn",
      message: "hi",
      ...params.payload,
    },
    schedule: { expr: "* * * * *", kind: "cron" },
    sessionTarget: "isolated",
    wakeMode: "now",
    ...(params.delivery ? { delivery: params.delivery } : {}),
  }) as unknown as Record<string, unknown>;
}

function normalizeMainSystemEventCreateJob(params: {
  name: string;
  schedule: Record<string, unknown>;
}): Record<string, unknown> {
  return normalizeCronJobCreate({
    enabled: true,
    name: params.name,
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    schedule: params.schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
  }) as unknown as Record<string, unknown>;
}

describe("normalizeCronJobCreate", () => {
  it("strips payload-level legacy delivery hints from live input", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "legacy",
      payload: {
        deliver: true,
        provider: " TeLeGrAm ",
        to: "7200373102",
      },
    });

    const payload = normalized.payload as Record<string, unknown>;
    expectPayloadDeliveryHintsCleared(payload);

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery).toEqual({ mode: "announce" });
  });

  it("trims agentId and drops null", () => {
    const normalized = normalizeCronJobCreate({
      agentId: " Ops ",
      enabled: true,
      name: "agent-set",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "isolated",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    expect(normalized.agentId).toBe("ops");

    const cleared = normalizeCronJobCreate({
      agentId: null,
      enabled: true,
      name: "agent-clear",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "isolated",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    expect(cleared.agentId).toBeNull();
  });

  it("trims sessionKey and drops blanks", () => {
    const normalized = normalizeCronJobCreate({
      enabled: true,
      name: "session-key",
      payload: { kind: "systemEvent", text: "hi" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionKey: "  agent:main:discord:channel:ops  ",
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    }) as unknown as Record<string, unknown>;
    expect(normalized.sessionKey).toBe("agent:main:discord:channel:ops");

    const cleared = normalizeCronJobCreate({
      enabled: true,
      name: "session-key-clear",
      payload: { kind: "systemEvent", text: "hi" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionKey: "   ",
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    }) as unknown as Record<string, unknown>;
    expect("sessionKey" in cleared).toBe(false);
  });

  it("strips top-level legacy delivery hints from live input", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      delivery: undefined,
      name: "legacy top-level delivery",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
    });

    const withLegacyTopLevel = normalizeCronJobCreate({
      channel: "Telegram",
      deliver: false,
      enabled: true,
      name: "legacy top-level delivery",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "isolated",
      threadId: " 99 ",
      to: "-1001234567890",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    expect(normalized.delivery).toEqual({ mode: "announce" });
    expect(withLegacyTopLevel.deliver).toBeUndefined();
    expect(withLegacyTopLevel.channel).toBeUndefined();
    expect(withLegacyTopLevel.to).toBeUndefined();
    expect(withLegacyTopLevel.threadId).toBeUndefined();

    const delivery = withLegacyTopLevel.delivery as Record<string, unknown>;
    expect(delivery).toEqual({ mode: "announce" });
  });

  it("canonicalizes delivery.channel casing", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      delivery: {
        channel: "Telegram",
        mode: "announce",
        to: "7200373102",
      },
      name: "delivery channel casing",
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expectAnnounceDeliveryTarget(delivery, { channel: "telegram", to: "7200373102" });
  });

  it("coerces ISO schedule.at to normalized ISO (UTC)", () => {
    expectNormalizedAtSchedule({ at: "2026-01-12T18:00:00" });
  });

  it("coerces schedule.atMs string to schedule.at (UTC)", () => {
    expectNormalizedAtSchedule({ atMs: "2026-01-12T18:00:00", kind: "at" });
  });

  it("migrates legacy schedule.cron into schedule.expr", () => {
    const normalized = normalizeMainSystemEventCreateJob({
      name: "legacy-cron-field",
      schedule: { cron: "*/10 * * * *", kind: "cron", tz: "UTC" },
    });

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("*/10 * * * *");
    expect(schedule.cron).toBeUndefined();
  });

  it("defaults cron stagger for recurring top-of-hour schedules", () => {
    const normalized = normalizeMainSystemEventCreateJob({
      name: "hourly",
      schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
    });

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("preserves explicit exact cron schedule", () => {
    const normalized = normalizeMainSystemEventCreateJob({
      name: "exact",
      schedule: { expr: "0 * * * *", kind: "cron", staggerMs: 0, tz: "UTC" },
    });

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.staggerMs).toBe(0);
  });

  it("defaults deleteAfterRun for one-shot schedules", () => {
    const normalized = normalizeCronJobCreate({
      enabled: true,
      name: "default delete",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
      schedule: { at: "2026-01-12T18:00:00Z" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    }) as unknown as Record<string, unknown>;

    expect(normalized.deleteAfterRun).toBe(true);
  });

  it("normalizes delivery mode and channel", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      delivery: {
        channel: " TeLeGrAm ",
        mode: " ANNOUNCE ",
        to: " 7200373102 ",
      },
      name: "delivery",
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expectAnnounceDeliveryTarget(delivery, { channel: "telegram", to: "7200373102" });
  });

  it("normalizes delivery accountId and strips blanks", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      delivery: {
        accountId: " coordinator ",
        channel: "telegram",
        mode: "announce",
        to: "-1003816714067",
      },
      name: "delivery account",
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.accountId).toBe("coordinator");
  });

  it("normalizes delivery threadId and preserves numeric values", () => {
    const stringThread = normalizeIsolatedAgentTurnCreateJob({
      delivery: {
        channel: "telegram",
        mode: "announce",
        threadId: " 1008013 ",
        to: "-1003816714067",
      },
      name: "delivery thread string",
    });

    expect((stringThread.delivery as Record<string, unknown>).threadId).toBe("1008013");

    const numericThread = normalizeIsolatedAgentTurnCreateJob({
      delivery: {
        channel: "telegram",
        mode: "announce",
        threadId: 1_008_013,
        to: "-1003816714067",
      },
      name: "delivery thread number",
    });

    expect((numericThread.delivery as Record<string, unknown>).threadId).toBe(1_008_013);
  });

  it("strips empty accountId from delivery", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      delivery: {
        accountId: "   ",
        channel: "telegram",
        mode: "announce",
      },
      name: "empty account",
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expect("accountId" in delivery).toBe(false);
  });

  it("normalizes webhook delivery mode and target URL", () => {
    const normalized = normalizeCronJobCreate({
      delivery: {
        mode: " WeBhOoK ",
        to: " https://example.invalid/cron ",
      },
      enabled: true,
      name: "webhook delivery",
      payload: { kind: "systemEvent", text: "hello" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("webhook");
    expect(delivery.to).toBe("https://example.invalid/cron");
  });

  it("does not default explicit mode-less delivery objects to announce", () => {
    const normalized = normalizeCronJobCreate({
      delivery: {
        channel: "telegram",
        to: "123",
      },
      enabled: true,
      name: "implicit announce",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBeUndefined();
    expect(delivery.channel).toBe("telegram");
    expect(delivery.to).toBe("123");
    expect(validateCronAddParams(normalized)).toBe(false);
  });

  it("defaults isolated agentTurn delivery to announce", () => {
    const normalized = normalizeIsolatedAgentTurnCreateJob({
      name: "default-announce",
    });

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
  });

  it("migrates legacy isolation settings to announce delivery", () => {
    const normalized = normalizeCronJobCreate({
      enabled: true,
      isolation: { postToMainPrefix: "Cron" },
      name: "legacy isolation",
      payload: {
        kind: "agentTurn",
        message: "hi",
      },
      schedule: { expr: "* * * * *", kind: "cron" },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBe("announce");
    expect((normalized as { isolation?: unknown }).isolation).toBeUndefined();
  });

  it("infers payload kind/session target and name for message-only jobs", () => {
    const normalized = normalizeCronJobCreate({
      payload: { message: "Nightly backup" },
      schedule: { everyMs: 60_000, kind: "every" },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toBe("Nightly backup");
    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.wakeMode).toBe("now");
    expect(typeof normalized.name).toBe("string");
  });

  it("maps top-level model/thinking/timeout into payload for legacy add params", () => {
    const normalized = normalizeCronJobCreate({
      allowUnsafeExternalContent: true,
      model: " openrouter/deepseek/deepseek-r1 ",
      name: "legacy root fields",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { everyMs: 60_000, kind: "every" },
      thinking: " high ",
      timeoutSeconds: 45,
      toolsAllow: [" exec ", " read "],
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.model).toBe("openrouter/deepseek/deepseek-r1");
    expect(payload.thinking).toBe("high");
    expect(payload.timeoutSeconds).toBe(45);
    expect(payload.toolsAllow).toEqual(["exec", "read"]);
    expect(payload.allowUnsafeExternalContent).toBe(true);
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("preserves timeoutSeconds=0 for no-timeout agentTurn payloads", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy no-timeout",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { everyMs: 60_000, kind: "every" },
      timeoutSeconds: 0,
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.timeoutSeconds).toBe(0);
  });

  it("preserves empty toolsAllow lists for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "empty-tools",
      payload: {
        kind: "agentTurn",
        message: "hello",
        toolsAllow: [],
      },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.toolsAllow).toEqual([]);
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("prunes agentTurn-only payload fields from systemEvent create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "system-event-prune",
      payload: {
        allowUnsafeExternalContent: true,
        fallbacks: ["openai/gpt-4.1-mini"],
        kind: "systemEvent",
        lightContext: true,
        model: "openai/gpt-5",
        text: "hello",
        thinking: "high",
        timeoutSeconds: 45,
        toolsAllow: ["exec"],
      },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      wakeMode: "now",
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload).toEqual({ kind: "systemEvent", text: "hello" });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("prunes schedule fields that do not belong to at schedules for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "at-prune",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
      schedule: {
        anchorMs: 123,
        at: "2026-01-12T18:00:00Z",
        everyMs: 60_000,
        expr: "* * * * *",
        kind: "at",
        staggerMs: 30_000,
        tz: "UTC",
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      at: new Date("2026-01-12T18:00:00Z").toISOString(),
      kind: "at",
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("prunes staggerMs from every schedules for create jobs", () => {
    const normalized = normalizeCronJobCreate({
      name: "every-prune",
      payload: {
        kind: "systemEvent",
        text: "hi",
      },
      schedule: {
        everyMs: 60_000,
        kind: "every",
        staggerMs: 30_000,
      },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      everyMs: 60_000,
      kind: "every",
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("coerces sessionTarget and wakeMode casing", () => {
    const normalized = normalizeCronJobCreate({
      name: "casing",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: " IsOlAtEd ",
      wakeMode: " NOW ",
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.wakeMode).toBe("now");
  });

  it("strips invalid delivery mode from partial delivery objects", () => {
    const normalized = normalizeCronJobCreate({
      delivery: { mode: "bogus", to: "123" },
      name: "delivery mode",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { expr: "* * * * *", kind: "cron" },
    }) as unknown as Record<string, unknown>;

    const delivery = normalized.delivery as Record<string, unknown>;
    expect(delivery.mode).toBeUndefined();
    expect(delivery.to).toBe("123");
  });

  it("resolves current sessionTarget to a persistent session when context is available", () => {
    const normalized = normalizeCronJobCreate(
      {
        name: "current-session",
        payload: { kind: "agentTurn", message: "hello" },
        schedule: { expr: "* * * * *", kind: "cron" },
        sessionTarget: "current",
      },
      { sessionContext: { sessionKey: "agent:main:discord:group:ops" } },
    ) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("session:agent:main:discord:group:ops");
  });

  it("falls back current sessionTarget to isolated without context", () => {
    const normalized = normalizeCronJobCreate({
      name: "current-without-context",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "current",
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("isolated");
  });

  it("preserves custom session ids with a session: prefix", () => {
    const normalized = normalizeCronJobCreate({
      name: "custom-session",
      payload: { kind: "agentTurn", message: "hello" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "session:MySessionID",
    }) as unknown as Record<string, unknown>;

    expect(normalized.sessionTarget).toBe("session:MySessionID");
  });

  it("rejects custom session ids with path separators", () => {
    expect(() =>
      normalizeCronJobCreate({
        name: "bad-custom-session",
        payload: { kind: "agentTurn", message: "hello" },
        schedule: { expr: "* * * * *", kind: "cron" },
        sessionTarget: "session:../../outside",
      }),
    ).toThrow("invalid cron sessionTarget session id");

    expect(() =>
      normalizeCronJobPatch({
        sessionTarget: "session:..\\outside",
      }),
    ).toThrow("invalid cron sessionTarget session id");
  });
});

describe("normalizeCronJobPatch", () => {
  it("infers agentTurn payloads from top-level model-only patch hints", () => {
    const normalized = normalizeCronJobPatch({
      model: "openrouter/deepseek/deepseek-r1",
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.model).toBe("openrouter/deepseek/deepseek-r1");
  });

  it("infers agentTurn kind for model-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        model: "anthropic/claude-sonnet-4-6",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("infers agentTurn kind for lightContext-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        lightContext: true,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.lightContext).toBe(true);
  });

  it("maps top-level fallback lists into agentTurn payload patches", () => {
    const normalized = normalizeCronJobPatch({
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toEqual(["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"]);
  });

  it("maps top-level toolsAllow lists into agentTurn payload patches", () => {
    const normalized = normalizeCronJobPatch({
      toolsAllow: [" exec ", " read "],
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toEqual(["exec", "read"]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("preserves empty fallback lists so patches can disable fallbacks", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        fallbacks: [],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toEqual([]);
  });

  it("preserves empty toolsAllow lists so patches can disable all tools", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        toolsAllow: [],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toEqual([]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("infers agentTurn kind for fallback-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.fallbacks).toEqual(["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"]);
  });

  it("does not infer agentTurn kind for malformed fallback-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        fallbacks: [123],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBeUndefined();
    expect(payload.fallbacks).toBeUndefined();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(false);
  });

  it("infers agentTurn kind for toolsAllow-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        toolsAllow: [" exec ", " read "],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toEqual(["exec", "read"]);
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("does not infer agentTurn kind for malformed toolsAllow-only payload patches", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        toolsAllow: [123],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBeUndefined();
    expect(payload.toolsAllow).toBeUndefined();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(false);
  });

  it("preserves null toolsAllow so patches can clear the allow-list", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        toolsAllow: null,
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.toolsAllow).toBeNull();
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
  it("does not infer agentTurn kind for delivery-only legacy hints", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        channel: "telegram",
        to: "+15550001111",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.kind).toBeUndefined();
    expectPayloadDeliveryHintsCleared(payload);
  });

  it("preserves null sessionKey patches and trims string values", () => {
    const trimmed = normalizeCronJobPatch({
      sessionKey: "  agent:main:telegram:group:-100123  ",
    }) as unknown as Record<string, unknown>;
    expect(trimmed.sessionKey).toBe("agent:main:telegram:group:-100123");

    const cleared = normalizeCronJobPatch({
      sessionKey: null,
    }) as unknown as Record<string, unknown>;
    expect(cleared.sessionKey).toBeNull();
  });

  it("normalizes cron stagger values in patch schedules", () => {
    const normalized = normalizeCronJobPatch({
      schedule: { expr: "0 * * * *", kind: "cron", staggerMs: "30000" },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule.staggerMs).toBe(30_000);
  });

  it("strips legacy patch threadId hints from live input", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        kind: "agentTurn",
        threadId: 77,
      },
    }) as unknown as Record<string, unknown>;

    expect(normalized.delivery).toBeUndefined();
    expect((normalized.payload as Record<string, unknown>).threadId).toBeUndefined();
  });

  it("prunes agentTurn-only payload fields from systemEvent patch payloads", () => {
    const normalized = normalizeCronJobPatch({
      payload: {
        allowUnsafeExternalContent: true,
        fallbacks: ["openai/gpt-4.1-mini"],
        kind: "systemEvent",
        lightContext: true,
        model: "openai/gpt-5",
        text: "hi",
        thinking: "high",
        timeoutSeconds: 15,
        toolsAllow: ["exec"],
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload).toEqual({ kind: "systemEvent", text: "hi" });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("prunes schedule fields that do not belong to at schedules for patches", () => {
    const normalized = normalizeCronJobPatch({
      schedule: {
        anchorMs: 123,
        at: "2026-01-12T18:00:00Z",
        everyMs: 60_000,
        expr: "* * * * *",
        kind: "at",
        staggerMs: 30_000,
        tz: "UTC",
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      at: new Date("2026-01-12T18:00:00Z").toISOString(),
      kind: "at",
    });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });

  it("prunes staggerMs from every schedules for patches", () => {
    const normalized = normalizeCronJobPatch({
      schedule: {
        everyMs: 60_000,
        kind: "every",
        staggerMs: 30_000,
      },
    }) as unknown as Record<string, unknown>;

    const schedule = normalized.schedule as Record<string, unknown>;
    expect(schedule).toEqual({
      everyMs: 60_000,
      kind: "every",
    });
    expect(validateCronUpdateParams({ id: "job-1", patch: normalized })).toBe(true);
  });
});
