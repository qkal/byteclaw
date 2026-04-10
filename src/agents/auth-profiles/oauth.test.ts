import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileStore } from "./types.js";

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: { access?: string } }) =>
    params.context?.access,
  refreshProviderOAuthCredentialWithPlugin: async () => null,
}));

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
}

function cfgFor(profileId: string, provider: string, mode: "api_key" | "token" | "oauth") {
  return {
    auth: {
      profiles: {
        [profileId]: { mode, provider },
      },
    },
  } satisfies OpenClawConfig;
}

function tokenStore(params: {
  profileId: string;
  provider: string;
  token?: string;
  expires?: number;
}): AuthProfileStore {
  return {
    profiles: {
      [params.profileId]: {
        provider: params.provider,
        token: params.token,
        type: "token",
        ...(params.expires !== undefined ? { expires: params.expires } : {}),
      },
    },
    version: 1,
  };
}

function githubCopilotTokenStore(profileId: string, includeInlineToken = true): AuthProfileStore {
  return {
    profiles: {
      [profileId]: {
        type: "token",
        provider: "github-copilot",
        ...(includeInlineToken ? { token: "" } : {}),
        tokenRef: { id: "GITHUB_TOKEN", provider: "default", source: "env" },
      },
    },
    version: 1,
  };
}

async function resolveWithConfig(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
}) {
  return resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    profileId: params.profileId,
    store: params.store,
  });
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

async function expectResolvedApiKey(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
  expectedApiKey: string;
}) {
  const result = await resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    profileId: params.profileId,
    store: params.store,
  });
  expect(result).toEqual({
    apiKey: params.expectedApiKey, // Pragma: allowlist secret
    provider: params.provider,
    email: undefined,
  });
}

beforeAll(loadOAuthModuleForTest);

afterAll(() => {
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
});

describe("resolveApiKeyForProfile config compatibility", () => {
  it("accepts token credentials when config mode is oauth", async () => {
    const profileId = "anthropic:token";
    const store: AuthProfileStore = {
      profiles: {
        [profileId]: {
          provider: "anthropic",
          token: "tok-123",
          type: "token",
        },
      },
      version: 1,
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "oauth"),
      profileId,
      store,
    });
    expect(result).toEqual({
      apiKey: "tok-123", // Pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("rejects token credentials when config mode is api_key", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      mode: "api_key",
      profileId,
      provider: "anthropic",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });

    expect(result).toBeNull();
  });

  it("rejects credentials when provider does not match config", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      mode: "token",
      profileId,
      provider: "openai",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toBeNull();
  });

  it("accepts oauth credentials when config mode is token (bidirectional compat)", async () => {
    const profileId = "anthropic:oauth";
    const store: AuthProfileStore = {
      profiles: {
        [profileId]: {
          access: "access-123",
          expires: Date.now() + 60_000,
          provider: "anthropic",
          refresh: "refresh-123",
          type: "oauth",
        },
      },
      version: 1,
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "token"),
      profileId,
      store,
    });
    // Token ↔ oauth are bidirectionally compatible bearer-token auth paths.
    expect(result).toEqual({
      apiKey: "access-123", // Pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });
});

describe("resolveApiKeyForProfile token expiry handling", () => {
  it("accepts token credentials when expires is undefined", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      mode: "token",
      profileId,
      provider: "anthropic",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123", // Pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("accepts token credentials when expires is in the future", async () => {
    const profileId = "anthropic:token-valid-expiry";
    const result = await resolveWithConfig({
      mode: "token",
      profileId,
      provider: "anthropic",
      store: tokenStore({
        expires: Date.now() + 60_000,
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123", // Pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("returns null for expired token credentials", async () => {
    const profileId = "anthropic:token-expired";
    const result = await resolveWithConfig({
      mode: "token",
      profileId,
      provider: "anthropic",
      store: tokenStore({
        expires: Date.now() - 1_000,
        profileId,
        provider: "anthropic",
        token: "tok-expired",
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null for token credentials when expires is 0", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      mode: "token",
      profileId,
      provider: "anthropic",
      store: tokenStore({
        expires: 0,
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null for token credentials when expires is invalid (NaN)", async () => {
    const profileId = "anthropic:token-invalid-expiry";
    const store = tokenStore({
      profileId,
      provider: "anthropic",
      token: "tok-123",
    });
    store.profiles[profileId] = {
      ...store.profiles[profileId],
      expires: Number.NaN,
      provider: "anthropic",
      token: "tok-123",
      type: "token",
    };
    const result = await resolveWithConfig({
      mode: "token",
      profileId,
      provider: "anthropic",
      store,
    });
    expect(result).toBeNull();
  });
});

describe("resolveApiKeyForProfile secret refs", () => {
  it("resolves api_key keyRef from env", async () => {
    const profileId = "openai:default";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-ref"; // Pragma: allowlist secret
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        profileId,
        store: {
          profiles: {
            [profileId]: {
              keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
              provider: "openai",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(result).toEqual({
        apiKey: "sk-openai-ref", // Pragma: allowlist secret
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves token tokenRef from env", async () => {
    const profileId = "github-copilot:default";
    await withEnvVar("GITHUB_TOKEN", "gh-ref-token", async () => {
      await expectResolvedApiKey({
        expectedApiKey: "gh-ref-token",
        mode: "token",
        profileId,
        provider: "github-copilot",
        store: githubCopilotTokenStore(profileId), // Pragma: allowlist secret
      });
    });
  });

  it("resolves token tokenRef without inline token when expires is absent", async () => {
    const profileId = "github-copilot:no-inline-token";
    await withEnvVar("GITHUB_TOKEN", "gh-ref-token", async () => {
      await expectResolvedApiKey({
        expectedApiKey: "gh-ref-token",
        mode: "token",
        profileId,
        provider: "github-copilot",
        store: githubCopilotTokenStore(profileId, false), // Pragma: allowlist secret
      });
    });
  });

  it("hard-fails when oauth mode is combined with token SecretRef input", async () => {
    const profileId = "anthropic:oauth-secretref-token";
    await expect(
      resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "anthropic", "oauth"),
        profileId,
        store: {
          profiles: {
            [profileId]: {
              provider: "anthropic",
              tokenRef: { id: "ANTHROPIC_TOKEN", provider: "default", source: "env" },
              type: "token",
            },
          },
          version: 1,
        },
      }),
    ).rejects.toThrow(/mode is "oauth"/i);
  });

  it("resolves inline ${ENV} api_key values", async () => {
    const profileId = "openai:inline-env";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-inline"; // Pragma: allowlist secret
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        profileId,
        store: {
          profiles: {
            [profileId]: {
              key: "${OPENAI_API_KEY}",
              provider: "openai",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(result).toEqual({
        apiKey: "sk-openai-inline", // Pragma: allowlist secret
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves inline ${ENV} token values", async () => {
    const profileId = "github-copilot:inline-env";
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-inline-token";
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "github-copilot", "token"),
        profileId,
        store: {
          profiles: {
            [profileId]: {
              provider: "github-copilot",
              token: "${GITHUB_TOKEN}",
              type: "token",
            },
          },
          version: 1,
        },
      });
      expect(result).toEqual({
        apiKey: "gh-inline-token", // Pragma: allowlist secret
        provider: "github-copilot",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
  });
});
