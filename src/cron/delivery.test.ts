import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery-plan.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    createdAtMs: now,
    enabled: true,
    id: "job-1",
    name: "test",
    payload: { kind: "agentTurn", message: "hello" },
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget: "isolated",
    state: {},
    updatedAtMs: now,
    wakeMode: "next-heartbeat",
    ...overrides,
  };
}

describe("resolveCronDeliveryPlan", () => {
  it("defaults to announce when delivery object has no mode", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { channel: "telegram", mode: undefined as never, to: "123" },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
  });

  it("defaults missing isolated agentTurn delivery to announce", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: undefined,
        payload: { kind: "agentTurn", message: "hello" },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("last");
  });

  it("resolves mode=none with requested=false and no channel (#21808)", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { mode: "none", to: "telegram:123" },
      }),
    );
    expect(plan.mode).toBe("none");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("telegram:123");
  });

  it("resolves webhook mode without channel routing", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      }),
    );
    expect(plan.mode).toBe("webhook");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("https://example.invalid/cron");
  });

  it("threads delivery.accountId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          accountId: " bot-a ",
          channel: "telegram",
          mode: "announce",
          to: "123",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
    expect(plan.accountId).toBe("bot-a");
  });

  it("threads delivery.threadId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          channel: "telegram",
          mode: "announce",
          threadId: "99",
          to: "-1001234567890",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("-1001234567890");
    expect(plan.threadId).toBe("99");
  });
});

describe("resolveFailureDestination", () => {
  it("merges global defaults with job-level overrides", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          channel: "telegram",
          failureDestination: { channel: "signal", mode: "announce" },
          mode: "announce",
          to: "111",
        },
      }),
      {
        accountId: "global-account",
        channel: "telegram",
        mode: "announce",
        to: "222",
      },
    );
    expect(plan).toEqual({
      accountId: "global-account",
      channel: "signal",
      mode: "announce",
      to: "222",
    });
  });

  it("returns null for webhook mode without destination URL", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          channel: "telegram",
          failureDestination: { mode: "webhook" },
          mode: "announce",
          to: "111",
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when failure destination matches primary delivery target", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          accountId: "bot-a",
          channel: "telegram",
          failureDestination: {
            accountId: "bot-a",
            channel: "telegram",
            mode: "announce",
            to: "111",
          },
          mode: "announce",
          to: "111",
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when webhook failure destination matches the primary webhook target", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/cron",
          },
          mode: "webhook",
          to: "https://example.invalid/cron",
        },
        payload: { kind: "systemEvent", text: "tick" },
        sessionTarget: "main",
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("does not reuse inherited announce recipient when switching failure destination to webhook", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          channel: "telegram",
          failureDestination: {
            mode: "webhook",
          },
          mode: "announce",
          to: "111",
        },
      }),
      {
        channel: "signal",
        mode: "announce",
        to: "group-abc",
      },
    );
    expect(plan).toBeNull();
  });

  it("allows job-level failure destination fields to clear inherited global values", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          channel: "telegram",
          failureDestination: {
            accountId: undefined as never,
            channel: undefined as never,
            mode: "announce",
            to: undefined as never,
          },
          mode: "announce",
          to: "111",
        },
      }),
      {
        accountId: "global-account",
        channel: "signal",
        mode: "announce",
        to: "group-abc",
      },
    );
    expect(plan).toEqual({
      accountId: undefined,
      channel: "last",
      mode: "announce",
      to: undefined,
    });
  });
});
