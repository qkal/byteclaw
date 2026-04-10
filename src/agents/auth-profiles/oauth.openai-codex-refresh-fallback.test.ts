import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
type GetOAuthApiKey = typeof import("@mariozechner/pi-ai/oauth").getOAuthApiKey;

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn<GetOAuthApiKey>(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

const { readCodexCliCredentialsCachedMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<() => OAuthCredential | null>(() => null),
}));

const { writeCodexCliCredentialsMock } = vi.hoisted(() => ({
  writeCodexCliCredentialsMock: vi.fn(() => true),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPluginMock,
} = vi.hoisted(() => ({
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }): Promise<OAuthCredential | undefined> => undefined,
  ),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: writeCodexCliCredentialsMock,
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
    getOAuthProviders: () => [
      { envApiKey: "OPENAI_API_KEY", id: "openai-codex", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // Pragma: allowlist secret
      { envApiKey: "ANTHROPIC_API_KEY", id: "anthropic", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // Pragma: allowlist secret
    ],
  };
});

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
  formatProviderAuthProfileApiKeyWithPlugin: formatProviderAuthProfileApiKeyWithPluginMock,
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

afterAll(() => {
  vi.doUnmock("@mariozechner/pi-ai/oauth");
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../../plugins/provider-runtime.js");
});

async function readPersistedStore(agentDir: string): Promise<AuthProfileStore> {
  return JSON.parse(
    await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
  ) as AuthProfileStore;
}

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
}): AuthProfileStore {
  return {
    profiles: {
      [params.profileId]: {
        access: params.access ?? "cached-access-token",
        expires: Date.now() - 60_000,
        provider: params.provider,
        refresh: "refresh-token",
        type: "oauth",
      },
    },
    version: 1,
  };
}

describe("resolveApiKeyForProfile openai-codex refresh fallback", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeAll(async () => {
    ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset();
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("Failed to extract accountId from token");
    });
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    writeCodexCliCredentialsMock.mockReset();
    writeCodexCliCredentialsMock.mockReturnValue(true);
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    buildProviderAuthDoctorHintWithPluginMock.mockReset();
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("falls back to cached access token when openai-codex refresh fails on accountId extraction", async () => {
    const profileId = "openai-codex:default";
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => params?.context as never,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );

    const result = await resolveApiKeyForProfile({
      agentDir,
      profileId,
      store: ensureAuthProfileStore(agentDir),
    });

    expect(result).toEqual({
      apiKey: "cached-access-token", // Pragma: allowlist secret
      provider: "openai-codex",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("persists plugin-refreshed openai-codex credentials before returning", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        access: "stale-access-token",
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      access: "rotated-access-token",
      accountId: "acct-rotated",
      expires: Date.now() + 86_400_000,
      provider: "openai-codex",
      refresh: "rotated-refresh-token",
      type: "oauth",
    });

    const result = await resolveApiKeyForProfile({
      agentDir,
      profileId,
      store: ensureAuthProfileStore(agentDir),
    });

    expect(result).toEqual({
      apiKey: "rotated-access-token",
      email: undefined,
      provider: "openai-codex",
    });

    const persisted = await readPersistedStore(agentDir);
    expect(persisted.profiles[profileId]).toMatchObject({
      access: "rotated-access-token",
      accountId: "acct-rotated",
      provider: "openai-codex",
      refresh: "rotated-refresh-token",
      type: "oauth",
    });
  });

  it("prefers fresh Codex CLI credentials when the stored default profile is expired", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        profiles: {
          [profileId]: {
            access: "expired-access-token",
            expires: Date.now() - 60_000,
            provider: "openai-codex",
            refresh: "expired-refresh-token",
            type: "oauth",
          },
        },
        version: 1,
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValueOnce({
      access: "fresh-cli-access-token",
      accountId: "acct-cli",
      expires: Date.now() + 86_400_000,
      provider: "openai-codex",
      refresh: "fresh-cli-refresh-token",
      type: "oauth",
    });

    await expect(
      resolveApiKeyForProfile({
        agentDir,
        profileId,
        store: ensureAuthProfileStore(agentDir),
      }),
    ).resolves.toEqual({
      apiKey: "fresh-cli-access-token",
      email: undefined,
      provider: "openai-codex",
    });

    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect(writeCodexCliCredentialsMock).not.toHaveBeenCalled();
  });

  it("refreshes expired Codex-managed credentials and persists them back to auth-profiles", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        profiles: {
          [profileId]: {
            access: "expired-access-token",
            expires: Date.now() - 60_000,
            provider: "openai-codex",
            refresh: "expired-refresh-token",
            type: "oauth",
          },
        },
        version: 1,
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      access: "still-expired-cli-access-token",
      accountId: "acct-cli",
      expires: Date.now() - 30_000,
      provider: "openai-codex",
      refresh: "still-expired-cli-refresh-token",
      type: "oauth",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      access: "rotated-cli-access-token",
      accountId: "acct-rotated",
      expires: Date.now() + 86_400_000,
      provider: "openai-codex",
      refresh: "rotated-cli-refresh-token",
      type: "oauth",
    });

    const result = await resolveApiKeyForProfile({
      agentDir,
      profileId,
      store: ensureAuthProfileStore(agentDir),
    });

    expect(result).toEqual({
      apiKey: "rotated-cli-access-token",
      email: undefined,
      provider: "openai-codex",
    });
    expect(writeCodexCliCredentialsMock).toHaveBeenCalledTimes(1);
    expect(writeCodexCliCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        access: "rotated-cli-access-token",
        accountId: "acct-rotated",
        managedBy: "codex-cli",
        provider: "openai-codex",
        refresh: "rotated-cli-refresh-token",
        type: "oauth",
      }),
    );

    const persisted = await readPersistedStore(agentDir);
    expect(persisted.profiles[profileId]).toMatchObject({
      access: "rotated-cli-access-token",
      accountId: "acct-rotated",
      provider: "openai-codex",
      refresh: "rotated-cli-refresh-token",
      type: "oauth",
    });
    expect(persisted.profiles[profileId]).not.toEqual(
      expect.objectContaining({
        access: "expired-access-token",
        provider: "openai-codex",
      }),
    );
  });

  it("adopts fresher stored credentials after refresh_token_reused", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      saveAuthProfileStore(
        {
          profiles: {
            [profileId]: {
              access: "reloaded-access-token",
              expires: Date.now() + 60_000,
              provider: "openai-codex",
              refresh: "reloaded-refresh-token",
              type: "oauth",
            },
          },
          version: 1,
        },
        agentDir,
      );
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        agentDir,
        profileId,
        store: ensureAuthProfileStore(agentDir),
      }),
    ).resolves.toEqual({
      apiKey: "reloaded-access-token",
      email: undefined,
      provider: "openai-codex",
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("retries Codex refresh once after refresh_token_reused updates only the stored refresh token", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai-codex"]?.refresh).toBe("refresh-token");
        saveAuthProfileStore(
          {
            profiles: {
              [profileId]: {
                access: "still-expired-access-token",
                expires: Date.now() - 5_000,
                provider: "openai-codex",
                refresh: "rotated-refresh-token",
                type: "oauth",
              },
            },
            version: 1,
          },
          agentDir,
        );
        throw new Error(
          '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
        );
      })
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai-codex"]?.refresh).toBe("rotated-refresh-token");
        return {
          apiKey: "retried-access-token",
          newCredentials: {
            access: "retried-access-token",
            expires: Date.now() + 60_000,
            refresh: "retried-refresh-token",
          },
        };
      });

    await expect(
      resolveApiKeyForProfile({
        agentDir,
        profileId,
        store: ensureAuthProfileStore(agentDir),
      }),
    ).resolves.toEqual({
      apiKey: "retried-access-token",
      email: undefined,
      provider: "openai-codex",
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    const persisted = await readPersistedStore(agentDir);
    expect(persisted.profiles[profileId]).toMatchObject({
      access: "retried-access-token",
      refresh: "retried-refresh-token",
    });
  });

  it("keeps throwing for non-codex providers on the same refresh error", async () => {
    const profileId = "anthropic:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "anthropic",
      }),
      agentDir,
    );

    await expect(
      resolveApiKeyForProfile({
        agentDir,
        profileId,
        store: ensureAuthProfileStore(agentDir),
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
  });

  it("does not use fallback for unrelated openai-codex refresh errors", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });

    await expect(
      resolveApiKeyForProfile({
        agentDir,
        profileId,
        store: ensureAuthProfileStore(agentDir),
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });
});
