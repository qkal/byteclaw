import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { type AuthProfileStore, ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearConfigCache, clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import { captureEnv } from "../test-utils/env.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";

const secretsRuntimePluginMocks = vi.hoisted(() => ({
  resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
  resolvePluginWebSearchProvidersMock: vi.fn(() => []),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: secretsRuntimePluginMocks.resolvePluginWebSearchProvidersMock,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins:
    secretsRuntimePluginMocks.resolveExternalAuthProfilesWithPluginsMock,
}));

export const OPENAI_ENV_KEY_REF = {
  id: "OPENAI_API_KEY",
  provider: "default",
  source: "env",
} as const;

export const OPENAI_FILE_KEY_REF = {
  id: "/providers/openai/apiKey",
  provider: "default",
  source: "file",
} as const;

export const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
export type SecretsRuntimeEnvSnapshot = ReturnType<typeof captureEnv>;

const allowInsecureTempSecretFile = process.platform === "win32";

export function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

export function loadAuthStoreWithProfiles(
  profiles: AuthProfileStore["profiles"],
): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

export async function createOpenAIFileRuntimeFixture(home: string) {
  const configDir = path.join(home, ".openclaw");
  const secretFile = path.join(configDir, "secrets.json");
  const agentDir = path.join(configDir, "agents", "main", "agent");
  const authStorePath = path.join(agentDir, "auth-profiles.json");

  await fs.mkdir(agentDir, { recursive: true });
  await fs.chmod(configDir, 0o700).catch(() => {});
  await fs.writeFile(
    secretFile,
    `${JSON.stringify({ providers: { openai: { apiKey: "sk-file-runtime" } } }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(
    authStorePath,
    `${JSON.stringify(
      {
        profiles: {
          "openai:default": {
            keyRef: OPENAI_FILE_KEY_REF,
            provider: "openai",
            type: "api_key",
          },
        },
        version: 1,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    agentDir,
    configDir,
    secretFile,
  };
}

export function createOpenAIFileRuntimeConfig(secretFile: string): OpenClawConfig {
  return asConfig({
    models: {
      providers: {
        openai: {
          apiKey: OPENAI_FILE_KEY_REF,
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
    secrets: {
      providers: {
        default: {
          mode: "json",
          path: secretFile,
          source: "file",
          ...(allowInsecureTempSecretFile ? { allowInsecurePath: true } : {}),
        },
      },
    },
  });
}

export function expectResolvedOpenAIRuntime(agentDir: string) {
  expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-file-runtime");
  expect(ensureAuthProfileStore(agentDir).profiles["openai:default"]).toMatchObject({
    key: "sk-file-runtime",
    type: "api_key",
  });
}

export function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  secretsRuntimePluginMocks.resolveExternalAuthProfilesWithPluginsMock.mockReset();
  secretsRuntimePluginMocks.resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
  secretsRuntimePluginMocks.resolvePluginWebSearchProvidersMock.mockReset();
  secretsRuntimePluginMocks.resolvePluginWebSearchProvidersMock.mockReturnValue([]);
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

export function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}
