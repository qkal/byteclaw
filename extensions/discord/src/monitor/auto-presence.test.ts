import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscordAutoPresenceController,
  resolveDiscordAutoPresenceDecision,
} from "./auto-presence.js";

function createStore(params?: {
  cooldownUntil?: number;
  failureCounts?: Record<string, number>;
}): AuthProfileStore {
  return {
    profiles: {
      "openai:default": {
        key: "sk-test",
        provider: "openai",
        type: "api_key",
      },
    },
    usageStats: {
      "openai:default": {
        ...(typeof params?.cooldownUntil === "number"
          ? { cooldownUntil: params.cooldownUntil }
          : {}),
        ...(params?.failureCounts ? { failureCounts: params.failureCounts } : {}),
      },
    },
    version: 1,
  };
}

function expectExhaustedDecision(params: { failureCounts: Record<string, number> }) {
  const now = Date.now();
  const decision = resolveDiscordAutoPresenceDecision({
    authStore: createStore({ cooldownUntil: now + 60_000, failureCounts: params.failureCounts }),
    discordConfig: {
      autoPresence: {
        enabled: true,
        exhaustedText: "token exhausted",
      },
    },
    gatewayConnected: true,
    now,
  });

  if (!decision) {
    throw new Error("expected an exhausted auto-presence decision");
  }
  expect(decision.state).toBe("exhausted");
  expect(decision.presence.status).toBe("dnd");
  expect(decision.presence.activities[0]?.state).toBe("token exhausted");
}

describe("discord auto presence", () => {
  it("maps exhausted runtime signal to dnd", () => {
    expectExhaustedDecision({ failureCounts: { rate_limit: 2 } });
  });

  it("treats overloaded cooldown as exhausted", () => {
    expectExhaustedDecision({ failureCounts: { overloaded: 2 } });
  });

  it("recovers from exhausted to online once a profile becomes usable", () => {
    let now = Date.now();
    let store = createStore({ cooldownUntil: now + 60_000, failureCounts: { rate_limit: 1 } });
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: true,
          exhaustedText: "token exhausted",
          intervalMs: 5000,
          minUpdateIntervalMs: 1000,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => store,
      now: () => now,
    });

    controller.runNow();

    now += 2000;
    store = createStore();
    controller.runNow();

    expect(updatePresence).toHaveBeenCalledTimes(2);
    expect(updatePresence.mock.calls).toEqual([
      [expect.objectContaining({ status: "dnd" })],
      [expect.objectContaining({ status: "online" })],
    ]);
  });

  it("re-applies presence on refresh even when signature is unchanged", () => {
    let now = Date.now();
    const store = createStore();
    const updatePresence = vi.fn();

    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: true,
          intervalMs: 60_000,
          minUpdateIntervalMs: 60_000,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => store,
      now: () => now,
    });

    controller.runNow();
    now += 1000;
    controller.runNow();
    controller.refresh();

    expect(updatePresence).toHaveBeenCalledTimes(2);
    expect(updatePresence.mock.calls).toEqual([
      [expect.objectContaining({ status: "online" })],
      [expect.objectContaining({ status: "online" })],
    ]);
  });

  it("does nothing when auto presence is disabled", () => {
    const updatePresence = vi.fn();
    const controller = createDiscordAutoPresenceController({
      accountId: "default",
      discordConfig: {
        autoPresence: {
          enabled: false,
        },
      },
      gateway: {
        isConnected: true,
        updatePresence,
      },
      loadAuthStore: () => createStore(),
    });

    controller.runNow();
    controller.start();
    controller.refresh();
    controller.stop();

    expect(controller.enabled).toBe(false);
    expect(updatePresence).not.toHaveBeenCalled();
  });
});
