import { describe, expect, it } from "vitest";
import { type AuthProfileStore, resolveAuthProfileOrder } from "./auth-profiles.js";

function makeApiKeyStore(provider: string, profileIds: string[]): AuthProfileStore {
  return {
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        {
          key: profileId.endsWith(":work") ? "sk-work" : "sk-default",
          provider,
          type: "api_key",
        },
      ]),
    ),
    version: 1,
  };
}

function makeApiKeyProfilesByProviderProvider(
  providerByProfileId: Record<string, string>,
): Record<string, { provider: string; mode: "api_key" }> {
  return Object.fromEntries(
    Object.entries(providerByProfileId).map(([profileId, provider]) => [
      profileId,
      { mode: "api_key", provider },
    ]),
  );
}

describe("resolveAuthProfileOrder", () => {
  it("normalizes z.ai aliases in auth.order", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { "z.ai": ["zai:work", "zai:default"] },
          profiles: makeApiKeyProfilesByProviderProvider({
            "zai:default": "zai",
            "zai:work": "zai",
          }),
        },
      },
      provider: "zai",
      store: makeApiKeyStore("zai", ["zai:default", "zai:work"]),
    });
    expect(order).toEqual(["zai:work", "zai:default"]);
  });
  it("normalizes provider casing in auth.order keys", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: { OpenAI: ["openai:work", "openai:default"] },
          profiles: makeApiKeyProfilesByProviderProvider({
            "openai:default": "openai",
            "openai:work": "openai",
          }),
        },
      },
      provider: "openai",
      store: makeApiKeyStore("openai", ["openai:default", "openai:work"]),
    });
    expect(order).toEqual(["openai:work", "openai:default"]);
  });
  it("normalizes z.ai aliases in auth.profiles", () => {
    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          profiles: makeApiKeyProfilesByProviderProvider({
            "zai:default": "z.ai",
            "zai:work": "Z.AI",
          }),
        },
      },
      provider: "zai",
      store: makeApiKeyStore("zai", ["zai:default", "zai:work"]),
    });
    expect(order).toEqual(["zai:default", "zai:work"]);
  });
  it("prioritizes oauth profiles when order missing", () => {
    const mixedStore: AuthProfileStore = {
      profiles: {
        "anthropic:default": {
          key: "sk-default",
          provider: "anthropic",
          type: "api_key",
        },
        "anthropic:oauth": {
          access: "access-token",
          expires: Date.now() + 60_000,
          provider: "anthropic",
          refresh: "refresh-token",
          type: "oauth",
        },
      },
      version: 1,
    };
    const order = resolveAuthProfileOrder({
      provider: "anthropic",
      store: mixedStore,
    });
    expect(order).toEqual(["anthropic:oauth", "anthropic:default"]);
  });
});
