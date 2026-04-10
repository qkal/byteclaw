import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramErrorScopeKey,
  resetTelegramErrorPolicyStoreForTest,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";

describe("telegram error policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetTelegramErrorPolicyStoreForTest();
  });

  afterEach(() => {
    resetTelegramErrorPolicyStoreForTest();
    vi.useRealTimers();
  });

  it("resolves policy and cooldown from the most specific config", () => {
    expect(
      resolveTelegramErrorPolicy({
        accountConfig: { errorCooldownMs: 1000, errorPolicy: "once" },
        groupConfig: { errorCooldownMs: 2000 },
        topicConfig: { errorPolicy: "silent" },
      }),
    ).toEqual({
      cooldownMs: 2000,
      policy: "silent",
    });
  });

  it("suppresses only repeated matching errors within the same scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId: "work",
      chatId: 42,
      threadId: 7,
    });

    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "429",
        scopeKey,
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "429",
        scopeKey,
      }),
    ).toBe(true);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "403",
        scopeKey,
      }),
    ).toBe(false);
  });

  it("keeps cooldowns per error message within the same scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId: "work",
      chatId: 42,
    });

    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "A",
        scopeKey,
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "B",
        scopeKey,
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "A",
        scopeKey,
      }),
    ).toBe(true);
  });

  it("prunes expired cooldowns within a single scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId: "work",
      chatId: 42,
    });

    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "A",
        scopeKey,
      }),
    ).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "B",
        scopeKey,
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "A",
        scopeKey,
      }),
    ).toBe(false);
  });

  it("does not leak suppression across accounts or threads", () => {
    const workMain = buildTelegramErrorScopeKey({
      accountId: "work",
      chatId: 42,
    });
    const personalMain = buildTelegramErrorScopeKey({
      accountId: "personal",
      chatId: 42,
    });
    const workTopic = buildTelegramErrorScopeKey({
      accountId: "work",
      chatId: 42,
      threadId: 9,
    });

    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "429",
        scopeKey: workMain,
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "429",
        scopeKey: personalMain,
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        cooldownMs: 1000,
        errorMessage: "429",
        scopeKey: workTopic,
      }),
    ).toBe(false);
  });
});
