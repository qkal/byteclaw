import { describe, expect, it } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";

describe("resolveAuthProfileOrder", () => {
  it("orders by lastUsed when no explicit order exists", () => {
    const order = resolveAuthProfileOrder({
      provider: "anthropic",
      store: {
        profiles: {
          "anthropic:a": {
            access: "access-token",
            expires: Date.now() + 60_000,
            provider: "anthropic",
            refresh: "refresh-token",
            type: "oauth",
          },
          "anthropic:b": {
            key: "sk-b",
            provider: "anthropic",
            type: "api_key",
          },
          "anthropic:c": {
            key: "sk-c",
            provider: "anthropic",
            type: "api_key",
          },
        },
        usageStats: {
          "anthropic:a": { lastUsed: 200 },
          "anthropic:b": { lastUsed: 100 },
          "anthropic:c": { lastUsed: 300 },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["anthropic:a", "anthropic:b", "anthropic:c"]);
  });
  it("pushes cooldown profiles to the end, ordered by cooldown expiry", () => {
    const now = Date.now();
    const order = resolveAuthProfileOrder({
      provider: "anthropic",
      store: {
        profiles: {
          "anthropic:cool1": {
            access: "access-token",
            expires: now + 60_000,
            provider: "anthropic",
            refresh: "refresh-token",
            type: "oauth",
          },
          "anthropic:cool2": {
            key: "sk-cool",
            provider: "anthropic",
            type: "api_key",
          },
          "anthropic:ready": {
            key: "sk-ready",
            provider: "anthropic",
            type: "api_key",
          },
        },
        usageStats: {
          "anthropic:cool1": { cooldownUntil: now + 5000 },
          "anthropic:cool2": { cooldownUntil: now + 1000 },
          "anthropic:ready": { lastUsed: 50 },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["anthropic:ready", "anthropic:cool2", "anthropic:cool1"]);
  });
});
