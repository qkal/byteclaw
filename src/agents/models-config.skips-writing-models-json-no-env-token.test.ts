import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  installModelsConfigTestHooks,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import type { ProviderConfig as ModelsProviderConfig } from "./models-config.providers.secrets.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

vi.mock("./models-config.providers.js", async () => {
  function createImplicitProvider(baseUrl: string): ModelsProviderConfig {
    return {
      api: "openai-completions",
      baseUrl,
      models: [
        {
          contextWindow: 8192,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
          id: "test-model",
          input: ["text"],
          maxTokens: 4096,
          name: "test-model",
          reasoning: false,
        },
      ],
    };
  }

  return {
    applyNativeStreamingUsageCompat: (providers: Record<string, ModelsProviderConfig>) => providers,
    enforceSourceManagedProviderSecrets: ({
      providers,
    }: {
      providers: Record<string, ModelsProviderConfig>;
    }) => providers,
    normalizeProviders: ({ providers }: { providers: Record<string, ModelsProviderConfig> }) =>
      providers,
    resolveImplicitProviders: async ({ env }: { env?: NodeJS.ProcessEnv }) => {
      const providers: Record<string, ModelsProviderConfig> = {
        chutes: {
          api: "openai-completions" as const,
          baseUrl: "https://llm.chutes.ai/v1",
          models: [],
        },
        deepseek: {
          ...createImplicitProvider("https://deepseek.example/v1"),
          apiKey: "DEEPSEEK_API_KEY",
        },
        mistral: {
          ...createImplicitProvider("https://mistral.example/v1"),
          apiKey: "MISTRAL_API_KEY",
        },
        xai: {
          ...createImplicitProvider("https://xai.example/v1"),
          apiKey: "XAI_API_KEY",
        },
      };
      if (env?.MINIMAX_API_KEY) {
        providers["minimax"] = {
          ...createImplicitProvider("https://minimax.example/v1"),
          apiKey: "MINIMAX_API_KEY",
        };
      }
      if (env?.SYNTHETIC_API_KEY) {
        providers["synthetic"] = {
          ...createImplicitProvider("https://synthetic.example/v1"),
          apiKey: "SYNTHETIC_API_KEY",
        };
      }
      return providers;
    },
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/store.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

interface ParsedProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  models?: { id: string }[];
}

async function runEnvProviderCase(params: {
  envVar: "MINIMAX_API_KEY" | "SYNTHETIC_API_KEY";
  envValue: string;
  providerKey: "minimax" | "synthetic";
  expectedApiKeyRef: string;
}) {
  const previousValue = process.env[params.envVar];
  process.env[params.envVar] = params.envValue;
  try {
    await ensureOpenClawModelsJson({});

    const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
    const raw = await fs.readFile(modelPath, "utf8");
    const parsed = JSON.parse(raw) as { providers: Record<string, ParsedProviderConfig> };
    const provider = parsed.providers[params.providerKey];
    expect(provider).toBeDefined();
    expect(provider?.apiKey).toBe(params.expectedApiKeyRef);
  } finally {
    if (previousValue === undefined) {
      delete process.env[params.envVar];
    } else {
      process.env[params.envVar] = previousValue;
    }
  }
}

describe("models-config", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
    ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
      await import("./models-config.js"));
  });

  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  it("writes marker-backed defaults but skips env-gated providers when no env token or profile exists", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"]);

        const agentDir = path.join(home, "agent-empty");
        // EnsureAuthProfileStore merges the main auth store into non-main dirs; point main at our temp dir.
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        const result = await ensureOpenClawModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as { providers: Record<string, ParsedProviderConfig> };

        expect(result.wrote).toBe(true);
        expect(Object.keys(parsed.providers).length).toBeGreaterThan(0);
        expect(parsed.providers["openai"]).toBeUndefined();
        expect(parsed.providers["minimax"]).toBeUndefined();
        expect(parsed.providers["synthetic"]).toBeUndefined();
      });
    });
  });

  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<
          string,
          {
            baseUrl?: string;
            models?: {
              id?: string;
              cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
            }[];
          }
        >;
      };

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
      expect(parsed.providers["custom-proxy"]?.models?.[0]).toMatchObject({
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "llama-3.1-8b",
      });
    });
  });

  it("adds minimax provider when MINIMAX_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envValue: "sk-minimax-test",
        envVar: "MINIMAX_API_KEY",
        expectedApiKeyRef: "MINIMAX_API_KEY",
        providerKey: "minimax", // Pragma: allowlist secret
      });
    });
  });

  it("adds synthetic provider when SYNTHETIC_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envValue: "sk-synthetic-test",
        envVar: "SYNTHETIC_API_KEY",
        expectedApiKeyRef: "SYNTHETIC_API_KEY",
        providerKey: "synthetic", // Pragma: allowlist secret
      });
    });
  });
});
