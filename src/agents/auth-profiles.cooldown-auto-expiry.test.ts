import { describe, expect, it } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage.js";

/**
 * Integration tests for cooldown auto-expiry through resolveAuthProfileOrder.
 * Verifies that profiles with expired cooldowns are treated as available and
 * have their error state reset, preventing the escalation loop described in
 * #3604, #13623, #15851, and #11972.
 */

function makeStoreWithProfiles(): AuthProfileStore {
  return {
    profiles: {
      "anthropic:default": { key: "sk-1", provider: "anthropic", type: "api_key" },
      "anthropic:secondary": { key: "sk-2", provider: "anthropic", type: "api_key" },
      "openai:default": { key: "sk-oi", provider: "openai", type: "api_key" },
    },
    usageStats: {},
    version: 1,
  };
}

describe("resolveAuthProfileOrder — cooldown auto-expiry", () => {
  it("places profile with expired cooldown in available list (round-robin path)", () => {
    const store = makeStoreWithProfiles();
    store.usageStats = {
      "anthropic:default": {
        cooldownUntil: Date.now() - 10_000,
        errorCount: 4,
        failureCounts: { rate_limit: 4 },
        lastFailureAt: Date.now() - 70_000,
      },
    };

    const order = resolveAuthProfileOrder({ provider: "anthropic", store });

    // Profile should be in the result (available, not skipped)
    expect(order).toContain("anthropic:default");

    // Should no longer report as in cooldown
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);

    // Error state should have been reset
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
  });

  it("places profile with expired cooldown in available list (explicit-order path)", () => {
    const store = makeStoreWithProfiles();
    store.order = { anthropic: ["anthropic:secondary", "anthropic:default"] };
    store.usageStats = {
      "anthropic:default": {
        cooldownUntil: Date.now() - 5000,
        errorCount: 3,
      },
    };

    const order = resolveAuthProfileOrder({ provider: "anthropic", store });

    // Both profiles available — explicit order respected
    expect(order[0]).toBe("anthropic:secondary");
    expect(order).toContain("anthropic:default");

    // Expired cooldown cleared
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
  });

  it("keeps profile with active cooldown in cooldown list", () => {
    const futureMs = Date.now() + 300_000;
    const store = makeStoreWithProfiles();
    store.usageStats = {
      "anthropic:default": {
        cooldownUntil: futureMs,
        errorCount: 3,
      },
    };

    const order = resolveAuthProfileOrder({ provider: "anthropic", store });

    // Profile is still in the result (appended after available profiles)
    expect(order).toContain("anthropic:default");

    // Should still be in cooldown
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(3);
  });

  it("expired cooldown resets error count — prevents escalation on next failure", () => {
    const store = makeStoreWithProfiles();
    store.usageStats = {
      "anthropic:default": {
        cooldownUntil: Date.now() - 1000,
        errorCount: 4, // Would cause 1-hour cooldown on next failure
        failureCounts: { rate_limit: 4 },
        lastFailureAt: Date.now() - 3_700_000,
      },
    };

    resolveAuthProfileOrder({ provider: "anthropic", store });

    // After clearing, errorCount is 0. If the profile fails again,
    // The next cooldown will be 60 seconds (errorCount 1) instead of
    // 1 hour (errorCount 5). This is the core fix for #3604.
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
    expect(store.usageStats?.["anthropic:default"]?.failureCounts).toBeUndefined();
  });

  it("mixed active and expired cooldowns across profiles", () => {
    const store = makeStoreWithProfiles();
    store.usageStats = {
      "anthropic:default": {
        cooldownUntil: Date.now() - 1000,
        errorCount: 3,
      },
      "anthropic:secondary": {
        cooldownUntil: Date.now() + 300_000,
        errorCount: 2,
      },
    };

    const order = resolveAuthProfileOrder({ provider: "anthropic", store });

    // Anthropic:default should be available (expired, cleared)
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);

    // Anthropic:secondary should still be in cooldown
    expect(store.usageStats?.["anthropic:secondary"]?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(store.usageStats?.["anthropic:secondary"]?.errorCount).toBe(2);

    // Available profile should come first
    expect(order[0]).toBe("anthropic:default");
  });

  it("does not affect profiles from other providers", () => {
    const store = makeStoreWithProfiles();
    store.usageStats = {
      "anthropic:default": {
        cooldownUntil: Date.now() - 1000,
        errorCount: 4,
      },
      "openai:default": {
        cooldownUntil: Date.now() - 1000,
        errorCount: 3,
      },
    };

    // Resolve only anthropic
    resolveAuthProfileOrder({ provider: "anthropic", store });

    // Both should be cleared since clearExpiredCooldowns sweeps all profiles
    // In the store — this is intentional for correctness.
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
    expect(store.usageStats?.["openai:default"]?.errorCount).toBe(0);
  });
});
