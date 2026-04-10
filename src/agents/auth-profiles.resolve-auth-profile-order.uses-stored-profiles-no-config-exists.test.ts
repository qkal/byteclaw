import { describe, expect, it } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";
import {
  ANTHROPIC_CFG,
  ANTHROPIC_STORE,
} from "./auth-profiles.resolve-auth-profile-order.fixtures.js";

describe("resolveAuthProfileOrder", () => {
  const store = ANTHROPIC_STORE;
  const cfg = ANTHROPIC_CFG;

  function resolveMinimaxOrderWithProfile(profile: {
    type: "token";
    provider: "minimax";
    token?: string;
    tokenRef?: { source: "env" | "file" | "exec"; provider: string; id: string };
    expires?: number;
  }) {
    return resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            minimax: ["minimax:default"],
          },
        },
      },
      provider: "minimax",
      store: {
        profiles: {
          "minimax:default": {
            ...profile,
          },
        },
        version: 1,
      },
    });
  }

  it("uses stored profiles when no config exists", () => {
    const order = resolveAuthProfileOrder({
      provider: "anthropic",
      store,
    });
    expect(order).toEqual(["anthropic:default", "anthropic:work"]);
  });
  it("prioritizes preferred profiles", () => {
    const order = resolveAuthProfileOrder({
      cfg,
      preferredProfile: "anthropic:work",
      provider: "anthropic",
      store,
    });
    expect(order[0]).toBe("anthropic:work");
    expect(order).toContain("anthropic:default");
  });
  it("drops explicit order entries that are missing from the store", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            minimax: ["minimax:default", "minimax:prod"],
          },
        },
      },
      provider: "minimax",
      store: {
        profiles: {
          "minimax:prod": {
            key: "sk-prod",
            provider: "minimax",
            type: "api_key",
          },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["minimax:prod"]);
  });
  it("falls back to stored provider profiles when config profile ids drift", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            "openai-codex": ["openai-codex:default"],
          },
          profiles: {
            "openai-codex:default": {
              mode: "oauth",
              provider: "openai-codex",
            },
          },
        },
      },
      provider: "openai-codex",
      store: {
        profiles: {
          "openai-codex:user@example.com": {
            access: "access-token",
            expires: Date.now() + 60_000,
            provider: "openai-codex",
            refresh: "refresh-token",
            type: "oauth",
          },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["openai-codex:user@example.com"]);
  });
  it("does not bypass explicit ids when the configured profile exists but is invalid", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            "openai-codex": ["openai-codex:default"],
          },
          profiles: {
            "openai-codex:default": {
              mode: "token",
              provider: "openai-codex",
            },
          },
        },
      },
      provider: "openai-codex",
      store: {
        profiles: {
          "openai-codex:default": {
            expires: Date.now() - 1000,
            provider: "openai-codex",
            token: "expired-token",
            type: "token",
          },
          "openai-codex:user@example.com": {
            access: "access-token",
            expires: Date.now() + 60_000,
            provider: "openai-codex",
            refresh: "refresh-token",
            type: "oauth",
          },
        },
        version: 1,
      },
    });
    expect(order).toEqual([]);
  });
  it("drops explicit order entries that belong to another provider", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            minimax: ["openai:default", "minimax:prod"],
          },
        },
      },
      provider: "minimax",
      store: {
        profiles: {
          "minimax:prod": {
            key: "sk-mini",
            provider: "minimax",
            type: "api_key",
          },
          "openai:default": {
            key: "sk-openai",
            provider: "openai",
            type: "api_key",
          },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["minimax:prod"]);
  });
  it.each([
    {
      caseName: "drops token profiles with empty credentials",
      profile: {
        provider: "minimax" as const,
        token: "   ",
        type: "token" as const,
      },
    },
    {
      caseName: "drops token profiles that are already expired",
      profile: {
        expires: Date.now() - 1000,
        provider: "minimax" as const,
        token: "sk-minimax",
        type: "token" as const,
      },
    },
    {
      caseName: "drops token profiles with invalid expires metadata",
      profile: {
        expires: 0,
        provider: "minimax" as const,
        token: "sk-minimax",
        type: "token" as const,
      },
    },
  ])("$caseName", ({ profile }) => {
    const order = resolveMinimaxOrderWithProfile(profile);
    expect(order).toEqual([]);
  });
  it("keeps api_key profiles backed by keyRef when plaintext key is absent", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            anthropic: ["anthropic:default"],
          },
        },
      },
      provider: "anthropic",
      store: {
        profiles: {
          "anthropic:default": {
            keyRef: {
              id: "anthropic/default",
              provider: "vault_local",
              source: "exec",
            },
            provider: "anthropic",
            type: "api_key",
          },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["anthropic:default"]);
  });
  it("keeps token profiles backed by tokenRef when expires is absent", () => {
    const order = resolveMinimaxOrderWithProfile({
      provider: "minimax",
      tokenRef: {
        id: "minimax/default",
        provider: "keychain",
        source: "exec",
      },
      type: "token",
    });
    expect(order).toEqual(["minimax:default"]);
  });
  it("drops tokenRef profiles when expires is invalid", () => {
    const order = resolveMinimaxOrderWithProfile({
      expires: 0,
      provider: "minimax",
      tokenRef: {
        id: "minimax/default",
        provider: "keychain",
        source: "exec",
      },
      type: "token",
    });
    expect(order).toEqual([]);
  });
  it("keeps token profiles with inline token when no expires is set", () => {
    const order = resolveMinimaxOrderWithProfile({
      provider: "minimax",
      token: "sk-minimax",
      type: "token",
    });
    expect(order).toEqual(["minimax:default"]);
  });
  it("keeps oauth profiles that can refresh", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            anthropic: ["anthropic:oauth"],
          },
        },
      },
      provider: "anthropic",
      store: {
        profiles: {
          "anthropic:oauth": {
            access: "",
            expires: Date.now() - 1000,
            provider: "anthropic",
            refresh: "refresh-token",
            type: "oauth",
          },
        },
        version: 1,
      },
    });
    expect(order).toEqual(["anthropic:oauth"]);
  });
});
