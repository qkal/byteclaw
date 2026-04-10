import { describe, expect, it } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";
import {
  ANTHROPIC_CFG,
  ANTHROPIC_STORE,
} from "./auth-profiles.resolve-auth-profile-order.fixtures.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

describe("resolveAuthProfileOrder", () => {
  const store = ANTHROPIC_STORE;
  const cfg = ANTHROPIC_CFG;

  function resolveWithAnthropicOrderAndUsage(params: {
    orderSource: "store" | "config";
    usageStats: NonNullable<AuthProfileStore["usageStats"]>;
  }) {
    const configuredOrder = { anthropic: ["anthropic:default", "anthropic:work"] };
    return resolveAuthProfileOrder({
      cfg:
        params.orderSource === "config"
          ? {
              auth: {
                order: configuredOrder,
                profiles: cfg.auth?.profiles,
              },
            }
          : undefined,
      provider: "anthropic",
      store:
        params.orderSource === "store"
          ? { ...store, order: configuredOrder, usageStats: params.usageStats }
          : { ...store, usageStats: params.usageStats },
    });
  }

  it("does not prioritize lastGood over round-robin ordering", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      provider: "anthropic",
      store: {
        ...store,
        lastGood: { anthropic: "anthropic:work" },
        usageStats: {
          "anthropic:default": { lastUsed: 100 },
          "anthropic:work": { lastUsed: 200 },
        },
      },
    });
    expect(order[0]).toBe("anthropic:default");
  });
  it("uses explicit profiles when order is missing", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      provider: "anthropic",
      store,
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
  });
  it("uses configured order when provided", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:work", "anthropic:default"] },
          profiles: cfg.auth?.profiles,
        },
      },
      provider: "anthropic",
      store,
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });
  it("prefers store order over config order", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:default", "anthropic:work"] },
          profiles: cfg.auth?.profiles,
        },
      },
      provider: "anthropic",
      store: {
        ...store,
        order: { anthropic: ["anthropic:work", "anthropic:default"] },
      },
    });
    expect(order).toEqual(["anthropic:work", "anthropic:default"]);
  });
  it.each(["store", "config"] as const)(
    "pushes cooldown profiles to the end even with %s order",
    (orderSource) => {
      const now = Date.now();
      const order = resolveWithAnthropicOrderAndUsage({
        orderSource,
        usageStats: {
          "anthropic:default": { cooldownUntil: now + 60_000 },
          "anthropic:work": { lastUsed: 1 },
        },
      });
      expect(order).toEqual(["anthropic:work", "anthropic:default"]);
    },
  );

  it.each(["store", "config"] as const)(
    "pushes disabled profiles to the end even with %s order",
    (orderSource) => {
      const now = Date.now();
      const order = resolveWithAnthropicOrderAndUsage({
        orderSource,
        usageStats: {
          "anthropic:default": {
            disabledReason: "billing",
            disabledUntil: now + 60_000,
          },
          "anthropic:work": { lastUsed: 1 },
        },
      });
      expect(order).toEqual(["anthropic:work", "anthropic:default"]);
    },
  );

  it.each(["store", "config"] as const)(
    "keeps OpenRouter explicit order even when cooldown fields exist (%s)",
    (orderSource) => {
      const now = Date.now();
      const explicitOrder = ["openrouter:default", "openrouter:work"];
      const order = resolveAuthProfileOrder({
        cfg:
          orderSource === "config"
            ? {
                auth: {
                  order: { openrouter: explicitOrder },
                },
              }
            : undefined,
        provider: "openrouter",
        store: {
          version: 1,
          ...(orderSource === "store" ? { order: { openrouter: explicitOrder } } : {}),
          profiles: {
            "openrouter:default": {
              key: "sk-or-default",
              provider: "openrouter",
              type: "api_key",
            },
            "openrouter:work": {
              key: "sk-or-work",
              provider: "openrouter",
              type: "api_key",
            },
          },
          usageStats: {
            "openrouter:default": {
              cooldownUntil: now + 60_000,
              disabledReason: "billing",
              disabledUntil: now + 120_000,
            },
          },
        },
      });

      expect(order).toEqual(explicitOrder);
    },
  );

  it("mode: oauth config accepts both oauth and token credentials (issue #559)", () => {
    const now = Date.now();
    const storeWithBothTypes: AuthProfileStore = {
      profiles: {
        "anthropic:oauth-cred": {
          access: "access-token",
          expires: now + 60_000,
          provider: "anthropic",
          refresh: "refresh-token",
          type: "oauth",
        },
        "anthropic:token-cred": {
          expires: now + 60_000,
          provider: "anthropic",
          token: "just-a-token",
          type: "token",
        },
      },
      version: 1,
    };

    const orderOauthCred = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "anthropic:oauth-cred": { mode: "oauth", provider: "anthropic" },
          },
        },
      },
      provider: "anthropic",
      store: storeWithBothTypes,
    });
    expect(orderOauthCred).toContain("anthropic:oauth-cred");

    const orderTokenCred = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "anthropic:token-cred": { mode: "oauth", provider: "anthropic" },
          },
        },
      },
      provider: "anthropic",
      store: storeWithBothTypes,
    });
    expect(orderTokenCred).toContain("anthropic:token-cred");
  });

  it("mode: token config rejects oauth credentials (issue #559 root cause)", () => {
    const now = Date.now();
    const storeWithOauth: AuthProfileStore = {
      profiles: {
        "anthropic:oauth-cred": {
          access: "access-token",
          expires: now + 60_000,
          provider: "anthropic",
          refresh: "refresh-token",
          type: "oauth",
        },
      },
      version: 1,
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: {
            "anthropic:oauth-cred": { mode: "token", provider: "anthropic" },
          },
        },
      },
      provider: "anthropic",
      store: storeWithOauth,
    });
    expect(order).not.toContain("anthropic:oauth-cred");
  });
});
