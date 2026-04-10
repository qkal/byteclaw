import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime,
} from "./auth-profiles.js";
import { AUTH_STORE_VERSION, log } from "./auth-profiles/constants.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

describe("ensureAuthProfileStore", () => {
  function withTempAgentDir<T>(prefix: string, run: (agentDir: string) => T): T {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      return run(agentDir);
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  }

  function writeAuthProfileStore(agentDir: string, profiles: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify({ profiles, version: AUTH_STORE_VERSION }, null, 2)}\n`,
      "utf8",
    );
  }

  function loadAuthProfile(agentDir: string, profileId: string): AuthProfileCredential {
    clearRuntimeAuthProfileStoreSnapshots();
    const store = ensureAuthProfileStore(agentDir);
    const profile = store.profiles[profileId];
    expect(profile).toBeDefined();
    return profile;
  }

  function expectApiKeyProfile(
    profile: AuthProfileCredential,
  ): Extract<AuthProfileCredential, { type: "api_key" }> {
    expect(profile.type).toBe("api_key");
    if (profile.type !== "api_key") {
      throw new Error(`Expected api_key profile, got ${profile.type}`);
    }
    return profile;
  }

  function expectTokenProfile(
    profile: AuthProfileCredential,
  ): Extract<AuthProfileCredential, { type: "token" }> {
    expect(profile.type).toBe("token");
    if (profile.type !== "token") {
      throw new Error(`Expected token profile, got ${profile.type}`);
    }
    return profile;
  }

  it("migrates legacy auth.json and deletes it (PR #368)", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-profiles-"));
    try {
      const legacyPath = path.join(agentDir, "auth.json");
      fs.writeFileSync(
        legacyPath,
        `${JSON.stringify(
          {
            anthropic: {
              access: "access-token",
              expires: Date.now() + 60_000,
              provider: "anthropic",
              refresh: "refresh-token",
              type: "oauth",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        provider: "anthropic",
        type: "oauth",
      });

      const migratedPath = path.join(agentDir, "auth-profiles.json");
      expect(fs.existsSync(migratedPath)).toBe(true);
      expect(fs.existsSync(legacyPath)).toBe(false);

      // Idempotent
      const store2 = ensureAuthProfileStore(agentDir);
      expect(store2.profiles["anthropic:default"]).toBeDefined();
      expect(fs.existsSync(legacyPath)).toBe(false);
    } finally {
      fs.rmSync(agentDir, { force: true, recursive: true });
    }
  });

  it("merges main auth profiles into agent store and keeps agent overrides", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-merge-"));
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const mainDir = path.join(root, "main-agent");
      const agentDir = path.join(root, "agent-x");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });

      process.env.OPENCLAW_AGENT_DIR = mainDir;
      process.env.PI_CODING_AGENT_DIR = mainDir;

      const mainStore = {
        profiles: {
          "anthropic:default": {
            key: "main-anthropic-key",
            provider: "anthropic",
            type: "api_key",
          },
          "openai:default": {
            key: "main-key",
            provider: "openai",
            type: "api_key",
          },
        },
        version: AUTH_STORE_VERSION,
      };
      fs.writeFileSync(
        path.join(mainDir, "auth-profiles.json"),
        `${JSON.stringify(mainStore, null, 2)}\n`,
        "utf8",
      );

      const agentStore = {
        profiles: {
          "openai:default": {
            key: "agent-key",
            provider: "openai",
            type: "api_key",
          },
        },
        version: AUTH_STORE_VERSION,
      };
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(agentStore, null, 2)}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        key: "main-anthropic-key",
        provider: "anthropic",
        type: "api_key",
      });
      expect(store.profiles["openai:default"]).toMatchObject({
        key: "agent-key",
        provider: "openai",
        type: "api_key",
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expected: {
        key: "sk-ant-alias",
        type: "api_key",
      },
      name: "mode/apiKey aliases map to type/key",
      profile: {
        apiKey: "sk-ant-alias",
        mode: "api_key",
        provider: "anthropic", // Pragma: allowlist secret
      },
    },
    {
      expected: {
        key: "sk-ant-canonical",
        type: "api_key",
      },
      name: "canonical type overrides conflicting mode alias",
      profile: {
        key: "sk-ant-canonical",
        mode: "token",
        provider: "anthropic",
        type: "api_key",
      },
    },
    {
      expected: {
        key: "sk-ant-canonical",
        type: "api_key",
      },
      name: "canonical key overrides conflicting apiKey alias",
      profile: {
        apiKey: "sk-ant-alias",
        key: "sk-ant-canonical",
        provider: "anthropic",
        type: "api_key", // Pragma: allowlist secret
      },
    },
    {
      expected: {
        key: "sk-ant-direct",
        type: "api_key",
      },
      name: "canonical profile shape remains unchanged",
      profile: {
        key: "sk-ant-direct",
        provider: "anthropic",
        type: "api_key",
      },
    },
  ] as const)(
    "normalizes auth-profiles credential aliases with canonical-field precedence: $name",
    ({ name, profile, expected }) => {
      withTempAgentDir("openclaw-auth-alias-", (agentDir) => {
        const storeData = {
          profiles: {
            "anthropic:work": profile,
          },
          version: AUTH_STORE_VERSION,
        };
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(storeData, null, 2)}\n`,
          "utf8",
        );

        const store = ensureAuthProfileStore(agentDir);
        expect(store.profiles["anthropic:work"], name).toMatchObject(expected);
      });
    },
  );

  it("normalizes mode/apiKey aliases while migrating legacy auth.json", () => {
    withTempAgentDir("openclaw-auth-legacy-alias-", (agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        `${JSON.stringify(
          {
            anthropic: {
              apiKey: "sk-ant-legacy",
              mode: "api_key",
              provider: "anthropic", // Pragma: allowlist secret
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["anthropic:default"]).toMatchObject({
        key: "sk-ant-legacy",
        provider: "anthropic",
        type: "api_key",
      });
    });
  });

  it("merges legacy oauth.json into auth-profiles.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-migrate-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const agentDir = path.join(root, "agent");
      const oauthDir = path.join(root, "credentials");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(oauthDir, { recursive: true });
      fs.writeFileSync(
        path.join(oauthDir, "oauth.json"),
        `${JSON.stringify(
          {
            "openai-codex": {
              access: "access-token",
              accountId: "acct_123",
              expires: Date.now() + 60_000,
              refresh: "refresh-token",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.env.OPENCLAW_STATE_DIR = root;
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["openai-codex:default"]).toMatchObject({
        access: "access-token",
        provider: "openai-codex",
        refresh: "refresh-token",
        type: "oauth",
      });

      const persisted = JSON.parse(
        fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
      };
      expect(persisted.profiles["openai-codex:default"]).toMatchObject({
        access: "access-token",
        provider: "openai-codex",
        refresh: "refresh-token",
        type: "oauth",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("exposes Codex CLI auth without persisting copied tokens into auth-profiles.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-external-sync-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(root, "codex-home");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, "auth.json"),
        `${JSON.stringify(
          {
            auth_mode: "chatgpt",
            last_refresh: "2026-03-01T00:00:00.000Z",
            tokens: {
              access_token: "codex-access-token",
              account_id: "acct_123",
              refresh_token: "codex-refresh-token",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      process.env.CODEX_HOME = codexHome;
      process.env.OPENCLAW_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = ensureAuthProfileStore(agentDir);
      expect(store.profiles["openai-codex:default"]).toMatchObject({
        access: "codex-access-token",
        provider: "openai-codex",
        refresh: "codex-refresh-token",
        type: "oauth",
      });

      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      if (previousAgentDir === undefined) {
        delete process.env.OPENCLAW_AGENT_DIR;
      } else {
        process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
      }
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not write inherited auth stores during secrets runtime reads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-runtime-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      const stateDir = path.join(root, ".openclaw");
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      const workerAgentDir = path.join(stateDir, "agents", "worker", "agent");
      const workerStorePath = path.join(workerAgentDir, "auth-profiles.json");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(mainAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            profiles: {
              "openai:default": {
                keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
                provider: "openai",
                type: "api_key",
              },
            },
            version: AUTH_STORE_VERSION,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      process.env.OPENCLAW_STATE_DIR = stateDir;
      clearRuntimeAuthProfileStoreSnapshots();

      const store = loadAuthProfileStoreForRuntime(workerAgentDir, { readOnly: true });

      expect(store.profiles["openai:default"]).toMatchObject({
        provider: "openai",
        type: "api_key",
      });
      expect(fs.existsSync(workerStorePath)).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("logs one warning with aggregated reasons for rejected auth-profiles entries", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      withTempAgentDir("openclaw-auth-invalid-", (agentDir) => {
        const invalidStore = {
          profiles: {
            "anthropic:missing-type": {
              provider: "anthropic",
            },
            "openai:missing-provider": {
              key: "sk-openai",
              type: "api_key",
            },
            "qwen:not-object": "broken",
          },
          version: AUTH_STORE_VERSION,
        };
        fs.writeFileSync(
          path.join(agentDir, "auth-profiles.json"),
          `${JSON.stringify(invalidStore, null, 2)}\n`,
          "utf8",
        );
        const store = ensureAuthProfileStore(agentDir);
        expect(store.profiles).toEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "ignored invalid auth profile entries during store load",
          {
            dropped: 3,
            keys: ["anthropic:missing-type", "openai:missing-provider", "qwen:not-object"],
            reasons: {
              invalid_type: 1,
              missing_provider: 1,
              non_object: 1,
            },
            source: "auth-profiles.json",
          },
        );
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    {
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          id: "OPENAI_API_KEY",
          provider: "default",
          source: "env",
        });
      },
      name: "migrates SecretRef object in `key` to `keyRef` and clears `key`",
      prefix: "openclaw-nonstr-key-ref-",
      profile: {
        key: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
        provider: "openai",
        type: "api_key",
      },
      profileId: "openai:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toBeUndefined();
      },
      name: "deletes non-string non-SecretRef `key` without setting keyRef",
      prefix: "openclaw-nonstr-key-num-",
      profile: {
        key: 12_345,
        provider: "openai",
        type: "api_key",
      },
      profileId: "openai:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          id: "CORRECT_VAR",
          provider: "default",
          source: "env",
        });
      },
      name: "does not overwrite existing `keyRef` when `key` contains a SecretRef",
      prefix: "openclaw-nonstr-key-dup-",
      profile: {
        key: { id: "WRONG_VAR", provider: "default", source: "env" },
        keyRef: { id: "CORRECT_VAR", provider: "default", source: "env" },
        provider: "openai",
        type: "api_key",
      },
      profileId: "openai:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyRef).toEqual({
          id: "OPENAI_API_KEY",
          provider: "default",
          source: "env",
        });
      },
      name: "overwrites malformed `keyRef` with migrated ref from `key`",
      prefix: "openclaw-nonstr-key-malformed-ref-",
      profile: {
        key: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
        keyRef: null,
        provider: "openai",
        type: "api_key",
      },
      profileId: "openai:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const apiKey = expectApiKeyProfile(profile);
        expect(apiKey.key).toBe("sk-valid-plaintext-key");
      },
      name: "preserves valid string `key` values unchanged",
      prefix: "openclaw-str-key-",
      profile: {
        key: "sk-valid-plaintext-key",
        provider: "openai",
        type: "api_key",
      },
      profileId: "openai:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBeUndefined();
        expect(token.tokenRef).toEqual({
          id: "ANTHROPIC_TOKEN",
          provider: "default",
          source: "env",
        });
      },
      name: "migrates SecretRef object in `token` to `tokenRef` and clears `token`",
      prefix: "openclaw-nonstr-token-ref-",
      profile: {
        provider: "anthropic",
        token: { id: "ANTHROPIC_TOKEN", provider: "default", source: "env" },
        type: "token",
      },
      profileId: "anthropic:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBeUndefined();
        expect(token.tokenRef).toBeUndefined();
      },
      name: "deletes non-string non-SecretRef `token` without setting tokenRef",
      prefix: "openclaw-nonstr-token-num-",
      profile: {
        provider: "anthropic",
        token: 99_999,
        type: "token",
      },
      profileId: "anthropic:default",
    },
    {
      assert(profile: AuthProfileCredential) {
        const token = expectTokenProfile(profile);
        expect(token.token).toBe("tok-valid-plaintext");
      },
      name: "preserves valid string `token` values unchanged",
      prefix: "openclaw-str-token-",
      profile: {
        provider: "anthropic",
        token: "tok-valid-plaintext",
        type: "token",
      },
      profileId: "anthropic:default",
    },
  ] as const)(
    "normalizes secret-backed auth profile fields during store load: $name (#58861)",
    (testCase) => {
      withTempAgentDir(testCase.prefix, (agentDir) => {
        writeAuthProfileStore(agentDir, { [testCase.profileId]: testCase.profile });
        const profile = loadAuthProfile(agentDir, testCase.profileId);
        testCase.assert(profile);
      });
    },
  );
});
