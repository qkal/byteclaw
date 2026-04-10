import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  OPENAI_ENV_KEY_REF,
  type SecretsRuntimeEnvSnapshot,
  asConfig,
  beginSecretsRuntimeIsolationForTest,
  endSecretsRuntimeIsolationForTest,
} from "./runtime-auth.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

vi.mock("./runtime-prepare.runtime.js", () => ({
  applyResolvedAssignments: () => {},
  collectAuthStoreAssignments: ({
    store,
    context,
  }: {
    store: AuthProfileStore;
    context: { env: NodeJS.ProcessEnv };
  }) => {
    for (const profile of Object.values(store.profiles)) {
      if (
        profile?.type === "api_key" &&
        profile.keyRef?.source === "env" &&
        typeof profile.keyRef.id === "string"
      ) {
        const key = context.env[profile.keyRef.id];
        if (typeof key === "string" && key.length > 0) {
          profile.key = key;
        }
      }
    }
  },
  collectConfigAssignments: () => {},
  createResolverContext: ({
    sourceConfig,
    env,
  }: {
    sourceConfig: unknown;
    env: NodeJS.ProcessEnv;
  }) => ({
    assignments: [],
    cache: {},
    env,
    sourceConfig,
    warningKeys: new Set<string>(),
    warnings: [],
  }),
  resolveRuntimeWebTools: async () => ({
    diagnostics: [],
    fetch: { diagnostics: [], providerSource: "none" },
    search: { diagnostics: [], providerSource: "none" },
  }),
  resolveSecretRefValues: async () => new Map(),
}));

function loadAuthStoreFromTestFile(agentDir?: string): AuthProfileStore {
  if (!agentDir) {
    return { profiles: {}, version: 1 };
  }
  try {
    const raw = readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8");
    return JSON.parse(raw) as AuthProfileStore;
  } catch {
    return { profiles: {}, version: 1 };
  }
}

describe("secrets runtime snapshot auth integration", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it("recomputes config-derived agent dirs when refreshing active secrets runtime snapshots", async () => {
    await withTempHome("openclaw-secrets-runtime-agent-dirs-", async (home) => {
      const mainAgentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      const opsAgentDir = path.join(home, ".openclaw", "agents", "ops", "agent");
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(opsAgentDir, { recursive: true });
      await fs.writeFile(
        path.join(mainAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            profiles: {
              "openai:default": {
                keyRef: OPENAI_ENV_KEY_REF,
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
      await fs.writeFile(
        path.join(opsAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            profiles: {
              "anthropic:ops": {
                keyRef: { id: "ANTHROPIC_API_KEY", provider: "default", source: "env" },
                provider: "anthropic",
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

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: asConfig({}),
        env: {
          ANTHROPIC_API_KEY: "sk-ops-runtime",
          OPENAI_API_KEY: "sk-main-runtime",
        },
        loadAuthStore: loadAuthStoreFromTestFile,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      });

      activateSecretsRuntimeSnapshot(prepared);
      expect(
        getActiveSecretsRuntimeSnapshot()?.authStores.find(
          (entry) => entry.agentDir === opsAgentDir,
        ),
      ).toBeUndefined();

      const refreshed = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: {
            list: [{ agentDir: opsAgentDir, id: "ops" }],
          },
        }),
        env: {
          ANTHROPIC_API_KEY: "sk-ops-runtime",
          OPENAI_API_KEY: "sk-main-runtime",
        },
        loadAuthStore: loadAuthStoreFromTestFile,
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
      });
      activateSecretsRuntimeSnapshot(refreshed);

      expect(
        getActiveSecretsRuntimeSnapshot()?.authStores.find(
          (entry) => entry.agentDir === opsAgentDir,
        )?.store.profiles["anthropic:ops"],
      ).toMatchObject({
        key: "sk-ops-runtime",
        keyRef: { id: "ANTHROPIC_API_KEY", provider: "default", source: "env" },
        type: "api_key",
      });
    });
  });
});
