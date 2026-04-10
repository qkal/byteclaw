import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore } from "./auth-profiles.js";
import {
  getApiKeyForModel,
  hasAvailableAuthForProvider,
  resolveApiKeyForProvider,
  resolveEnvApiKey,
} from "./model-auth.js";

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    buildProviderMissingAuthMessageWithPlugin: (params: {
      provider: string;
      context: { listProfileIds: (providerId: string) => string[] };
    }) => {
      if (
        params.provider === "openai" &&
        params.context.listProfileIds("openai-codex").length > 0
      ) {
        return 'No API key found for provider "openai". Use openai-codex/gpt-5.4.';
      }
      return undefined;
    },
    formatProviderAuthProfileApiKeyWithPlugin: async () => undefined,
    refreshProviderOAuthCredentialWithPlugin: async () => null,
    resolveExternalAuthProfilesWithPlugins: () => [],
    resolveProviderSyntheticAuthWithPlugin: (params: {
      provider: string;
      context: { providerConfig?: { api?: string; baseUrl?: string; models?: unknown[] } };
    }) => {
      if (params.provider !== "ollama" && params.provider !== "demo-local") {
        return undefined;
      }
      const {providerConfig} = params.context;
      const hasMeaningfulOllamaConfig =
        params.provider !== "ollama"
          ? Boolean(providerConfig?.api?.trim()) ||
            Boolean(providerConfig?.baseUrl?.trim()) ||
            (Array.isArray(providerConfig?.models) && providerConfig.models.length > 0)
          : (Array.isArray(providerConfig?.models) && providerConfig.models.length > 0) ||
            Boolean(providerConfig?.api?.trim() && providerConfig.api.trim() !== "ollama") ||
            Boolean(
              providerConfig?.baseUrl?.trim() &&
              providerConfig.baseUrl.trim().replace(/\/+$/, "") !== "http://127.0.0.1:11434",
            );
      if (!hasMeaningfulOllamaConfig) {
        return undefined;
      }
      return {
        apiKey: params.provider === "ollama" ? "ollama-local" : "demo-local",
        mode: "api-key" as const,
        source: `models.providers.${params.provider} (synthetic local key)`,
      };
    },
    shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
      provider: string;
      context: { resolvedApiKey?: string };
    }) => {
      const expectedMarker =
        params.provider === "ollama"
          ? "ollama-local"
          : (params.provider === "demo-local"
            ? "demo-local"
            : undefined);
      return Boolean(expectedMarker && params.context.resolvedApiKey?.trim() === expectedMarker);
    },
  };
});

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

const envVar = (...parts: string[]) => parts.join("_");

const oauthFixture = {
  access: "access-token",
  accountId: "acct_123",
  expires: Date.now() + 60_000,
  refresh: "refresh-token",
};

const BEDROCK_PROVIDER_CFG = {
  models: {
    providers: {
      "amazon-bedrock": {
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        models: [],
      },
    },
  },
} as const;

async function resolveBedrockProvider() {
  return resolveApiKeyForProvider({
    cfg: BEDROCK_PROVIDER_CFG as never,
    provider: "amazon-bedrock",
    store: { profiles: {}, version: 1 },
  });
}

async function expectBedrockAuthSource(params: {
  env: Record<string, string | undefined>;
  expectedSource: string;
}) {
  await withEnvAsync(params.env, async () => {
    const resolved = await resolveBedrockProvider();
    expect(resolved.mode).toBe("aws-sdk");
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.source).toContain(params.expectedSource);
  });
}

describe("getApiKeyForModel", () => {
  it("reads oauth auth-profiles entries from auth-profiles.json via explicit profile", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-"));

    try {
      const agentDir = path.join(tempDir, "agent");
      await withEnvAsync(
        {
          OPENCLAW_AGENT_DIR: agentDir,
          OPENCLAW_STATE_DIR: tempDir,
          PI_CODING_AGENT_DIR: agentDir,
        },
        async () => {
          const authProfilesPath = path.join(agentDir, "auth-profiles.json");
          await fs.mkdir(agentDir, { mode: 0o700, recursive: true });
          await fs.writeFile(
            authProfilesPath,
            `${JSON.stringify(
              {
                profiles: {
                  "openai-codex:default": {
                    provider: "openai-codex",
                    type: "oauth",
                    ...oauthFixture,
                  },
                },
                version: 1,
              },
              null,
              2,
            )}\n`,
            "utf8",
          );

          const model = {
            api: "openai-codex-responses",
            id: "codex-mini-latest",
            provider: "openai-codex",
          } as Model<Api>;

          const store = ensureAuthProfileStore(process.env.OPENCLAW_AGENT_DIR, {
            allowKeychainPrompt: false,
          });
          const apiKey = await getApiKeyForModel({
            agentDir: process.env.OPENCLAW_AGENT_DIR,
            model,
            profileId: "openai-codex:default",
            store,
          });
          expect(apiKey.apiKey).toBe(oauthFixture.access);
        },
      );
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("suggests openai-codex when only Codex OAuth is configured", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));

    try {
      const agentDir = path.join(tempDir, "agent");
      await withEnvAsync(
        {
          OPENAI_API_KEY: undefined,
          OPENCLAW_AGENT_DIR: agentDir,
          OPENCLAW_STATE_DIR: tempDir,
          PI_CODING_AGENT_DIR: agentDir,
        },
        async () => {
          const authProfilesPath = path.join(tempDir, "agent", "auth-profiles.json");
          await fs.mkdir(path.dirname(authProfilesPath), {
            mode: 0o700,
            recursive: true,
          });
          await fs.writeFile(
            authProfilesPath,
            `${JSON.stringify(
              {
                profiles: {
                  "openai-codex:default": {
                    provider: "openai-codex",
                    type: "oauth",
                    ...oauthFixture,
                  },
                },
                version: 1,
              },
              null,
              2,
            )}\n`,
            "utf8",
          );

          const error: unknown = null;
          try {
            await resolveApiKeyForProvider({ provider: "openai" });
          } catch (error) {
            error = error;
          }
          expect(String(error)).toContain("openai-codex/gpt-5.4");
        },
      );
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("throws when ZAI API key is missing", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
      async () => {
        const error: unknown = null;
        try {
          await resolveApiKeyForProvider({
            provider: "zai",
            store: { profiles: {}, version: 1 },
          });
        } catch (error) {
          error = error;
        }

        expect(String(error)).toContain('No API key found for provider "zai".');
      },
    );
  });

  it("accepts legacy Z_AI_API_KEY for zai", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: "zai-test-key", // Pragma: allowlist secret
      },
      async () => {
        const resolved = await resolveApiKeyForProvider({
          provider: "zai",
          store: { profiles: {}, version: 1 },
        });
        expect(resolved.apiKey).toBe("zai-test-key");
        expect(resolved.source).toContain("Z_AI_API_KEY");
      },
    );
  });

  it("keeps stored provider auth ahead of env by default", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "env-openai-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        store: {
          profiles: {
            "openai:default": {
              key: "stored-openai-key",
              provider: "openai",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("stored-openai-key");
      expect(resolved.source).toBe("profile:openai:default");
      expect(resolved.profileId).toBe("openai:default");
    });
  });

  it("supports env-first precedence for live auth probes", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "env-openai-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        credentialPrecedence: "env-first",
        provider: "openai",
        store: {
          profiles: {
            "openai:default": {
              key: "stored-openai-key",
              provider: "openai",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("env-openai-key");
      expect(resolved.source).toContain("OPENAI_API_KEY");
      expect(resolved.profileId).toBeUndefined();
    });
  });

  it("hasAvailableAuthForProvider('google') accepts GOOGLE_API_KEY fallback", async () => {
    await withEnvAsync(
      {
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: "google-test-key", // Pragma: allowlist secret
      },
      async () => {
        await expect(
          hasAvailableAuthForProvider({
            provider: "google",
            store: { profiles: {}, version: 1 },
          }),
        ).resolves.toBe(true);
      },
    );
  });

  it("hasAvailableAuthForProvider returns false when no provider auth is available", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
      async () => {
        await expect(
          hasAvailableAuthForProvider({
            provider: "zai",
            store: { profiles: {}, version: 1 },
          }),
        ).resolves.toBe(false);
      },
    );
  });

  it("resolves Synthetic API key from env", async () => {
    await withEnvAsync({ [envVar("SYNTHETIC", "API", "KEY")]: "synthetic-test-key" }, async () => {
      // Pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "synthetic",
        store: { profiles: {}, version: 1 },
      });
      expect(resolved.apiKey).toBe("synthetic-test-key");
      expect(resolved.source).toContain("SYNTHETIC_API_KEY");
    });
  });

  it("resolves Qianfan API key from env", async () => {
    await withEnvAsync({ [envVar("QIANFAN", "API", "KEY")]: "qianfan-test-key" }, async () => {
      // Pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "qianfan",
        store: { profiles: {}, version: 1 },
      });
      expect(resolved.apiKey).toBe("qianfan-test-key");
      expect(resolved.source).toContain("QIANFAN_API_KEY");
    });
  });

  it("resolves Qwen API key from env", async () => {
    await withEnvAsync(
      { [envVar("MODELSTUDIO", "API", "KEY")]: "modelstudio-test-key" },
      async () => {
        // Pragma: allowlist secret
        const resolved = await resolveApiKeyForProvider({
          provider: "qwen",
          store: { profiles: {}, version: 1 },
        });
        expect(resolved.apiKey).toBe("modelstudio-test-key");
        expect(resolved.source).toContain("MODELSTUDIO_API_KEY");
      },
    );
  });

  it("resolves synthetic local auth key for configured ollama provider without apiKey", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "openai-completions",
                baseUrl: "http://gpu-node-server:11434",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: { profiles: {}, version: 1 },
      });
      expect(resolved.apiKey).toBe("ollama-local");
      expect(resolved.mode).toBe("api-key");
      expect(resolved.source).toContain("synthetic local key");
    });
  });

  it("does not mint synthetic local auth for default-ish ollama stubs", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      await expect(
        resolveApiKeyForProvider({
          cfg: {
            models: {
              providers: {
                ollama: {
                  api: "ollama",
                  baseUrl: "http://127.0.0.1:11434",
                  models: [],
                },
              },
            },
          },
          provider: "ollama",
          store: { profiles: {}, version: 1 },
        }),
      ).rejects.toThrow(/No API key found for provider "ollama"/);
    });
  });

  it("prefers explicit OLLAMA_API_KEY over synthetic local key", async () => {
    await withEnvAsync({ [envVar("OLLAMA", "API", "KEY")]: "env-ollama-key" }, async () => {
      // Pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "openai-completions",
                baseUrl: "http://gpu-node-server:11434",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: { profiles: {}, version: 1 },
      });
      expect(resolved.apiKey).toBe("env-ollama-key");
      expect(resolved.source).toContain("OLLAMA_API_KEY");
    });
  });

  it("prefers explicit OLLAMA_API_KEY over the stored ollama-local profile", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: "env-ollama-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                apiKey: "OLLAMA_API_KEY",
                baseUrl: "https://ollama.com",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: {
          profiles: {
            "ollama:default": {
              key: "ollama-local",
              provider: "ollama",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("env-ollama-key");
      expect(resolved.source).toContain("OLLAMA_API_KEY");
      expect(resolved.profileId).toBeUndefined();
    });
  });

  it("prefers explicit configured ollama apiKey over the stored ollama-local profile", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                apiKey: "config-ollama-key",
                baseUrl: "https://ollama.com",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: {
          profiles: {
            "ollama:default": {
              key: "ollama-local",
              provider: "ollama",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("config-ollama-key");
      expect(resolved.source).toBe("models.json");
      expect(resolved.profileId).toBeUndefined();
    });
  });

  it("falls back to the stored ollama-local profile when no real ollama auth exists", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                apiKey: "OLLAMA_API_KEY",
                baseUrl: "https://ollama.com",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: {
          profiles: {
            "ollama:default": {
              key: "ollama-local",
              provider: "ollama",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("ollama-local");
      expect(resolved.source).toBe("profile:ollama:default");
      expect(resolved.profileId).toBe("ollama:default");
    });
  });

  it("keeps a real stored ollama profile ahead of env auth", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: "env-ollama-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                apiKey: "OLLAMA_API_KEY",
                baseUrl: "https://ollama.com",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: {
          profiles: {
            "ollama:default": {
              key: "stored-ollama-key",
              provider: "ollama",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("stored-ollama-key");
      expect(resolved.source).toBe("profile:ollama:default");
      expect(resolved.profileId).toBe("ollama:default");
    });
  });

  it("defers every stored ollama-local profile until real auth sources are checked", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: "env-ollama-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                apiKey: "OLLAMA_API_KEY",
                baseUrl: "https://ollama.com",
                models: [],
              },
            },
          },
        },
        provider: "ollama",
        store: {
          profiles: {
            "ollama:default": {
              key: "ollama-local",
              provider: "ollama",
              type: "api_key",
            },
            "ollama:secondary": {
              key: "ollama-local",
              provider: "ollama",
              type: "api_key",
            },
          },
          version: 1,
        },
      });
      expect(resolved.apiKey).toBe("env-ollama-key");
      expect(resolved.source).toContain("OLLAMA_API_KEY");
      expect(resolved.profileId).toBeUndefined();
    });
  });

  it("defers plugin-owned synthetic profile markers without core provider branching", async () => {
    const resolved = await resolveApiKeyForProvider({
      cfg: {
        models: {
          providers: {
            "demo-local": {
              api: "openai-completions",
              apiKey: "config-demo-key",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "demo-local",
      store: {
        profiles: {
          "demo-local:default": {
            key: "demo-local",
            provider: "demo-local",
            type: "api_key",
          },
        },
        version: 1,
      },
    });
    expect(resolved.apiKey).toBe("config-demo-key");
    expect(resolved.source).toBe("models.json");
    expect(resolved.profileId).toBeUndefined();
  });

  it("still throws for ollama when no env/profile/config provider is available", async () => {
    await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
      await expect(
        resolveApiKeyForProvider({
          provider: "ollama",
          store: { profiles: {}, version: 1 },
        }),
      ).rejects.toThrow('No API key found for provider "ollama".');
    });
  });

  it("resolves Vercel AI Gateway API key from env", async () => {
    await withEnvAsync({ [envVar("AI_GATEWAY", "API", "KEY")]: "gateway-test-key" }, async () => {
      // Pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "vercel-ai-gateway",
        store: { profiles: {}, version: 1 },
      });
      expect(resolved.apiKey).toBe("gateway-test-key");
      expect(resolved.source).toContain("AI_GATEWAY_API_KEY");
    });
  });

  it("prefers Bedrock bearer token over access keys and profile", async () => {
    await expectBedrockAuthSource({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token", // Pragma: allowlist secret
        AWS_ACCESS_KEY_ID: "access-key",
        [envVar("AWS", "SECRET", "ACCESS", "KEY")]: "secret-key", // Pragma: allowlist secret
        AWS_PROFILE: "profile",
      },
      expectedSource: "AWS_BEARER_TOKEN_BEDROCK",
    });
  });

  it("prefers Bedrock access keys over profile", async () => {
    await expectBedrockAuthSource({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: "access-key",
        [envVar("AWS", "SECRET", "ACCESS", "KEY")]: "secret-key", // Pragma: allowlist secret
        AWS_PROFILE: "profile",
      },
      expectedSource: "AWS_ACCESS_KEY_ID",
    });
  });

  it("uses Bedrock profile when access keys are missing", async () => {
    await expectBedrockAuthSource({
      env: {
        AWS_ACCESS_KEY_ID: undefined,
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_PROFILE: "profile",
        AWS_SECRET_ACCESS_KEY: undefined,
      },
      expectedSource: "AWS_PROFILE",
    });
  });

  it("accepts VOYAGE_API_KEY for voyage", async () => {
    await withEnvAsync({ [envVar("VOYAGE", "API", "KEY")]: "voyage-test-key" }, async () => {
      // Pragma: allowlist secret
      const voyage = await resolveApiKeyForProvider({
        provider: "voyage",
        store: { profiles: {}, version: 1 },
      });
      expect(voyage.apiKey).toBe("voyage-test-key");
      expect(voyage.source).toContain("VOYAGE_API_KEY");
    });
  });

  it("strips embedded CR/LF from ANTHROPIC_API_KEY", async () => {
    await withEnvAsync({ [envVar("ANTHROPIC", "API", "KEY")]: "sk-ant-test-\r\nkey" }, async () => {
      // Pragma: allowlist secret
      const resolved = resolveEnvApiKey("anthropic");
      expect(resolved?.apiKey).toBe("sk-ant-test-key");
      expect(resolved?.source).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("resolveEnvApiKey('huggingface') returns HUGGINGFACE_HUB_TOKEN when set", async () => {
    await withEnvAsync(
      {
        HF_TOKEN: undefined,
        HUGGINGFACE_HUB_TOKEN: "hf_hub_xyz",
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_hub_xyz");
        expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('huggingface') prefers HUGGINGFACE_HUB_TOKEN over HF_TOKEN when both set", async () => {
    await withEnvAsync(
      {
        HF_TOKEN: "hf_second",
        HUGGINGFACE_HUB_TOKEN: "hf_hub_first",
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_hub_first");
        expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('huggingface') returns HF_TOKEN when only HF_TOKEN set", async () => {
    await withEnvAsync(
      {
        HF_TOKEN: "hf_abc123",
        HUGGINGFACE_HUB_TOKEN: undefined,
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_abc123");
        expect(resolved?.source).toContain("HF_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('opencode-go') falls back to OPENCODE_ZEN_API_KEY", async () => {
    await withEnvAsync(
      {
        OPENCODE_API_KEY: undefined,
        OPENCODE_ZEN_API_KEY: "sk-opencode-zen-fallback", // Pragma: allowlist secret
      },
      async () => {
        const resolved = resolveEnvApiKey("opencode-go");
        expect(resolved?.apiKey).toBe("sk-opencode-zen-fallback");
        expect(resolved?.source).toContain("OPENCODE_ZEN_API_KEY");
      },
    );
  });

  it("resolveEnvApiKey('minimax-portal') accepts MINIMAX_OAUTH_TOKEN", async () => {
    await withEnvAsync(
      {
        MINIMAX_API_KEY: undefined,
        MINIMAX_OAUTH_TOKEN: "minimax-oauth-token",
      },
      async () => {
        const resolved = resolveEnvApiKey("minimax-portal");
        expect(resolved?.apiKey).toBe("minimax-oauth-token");
        expect(resolved?.source).toContain("MINIMAX_OAUTH_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('anthropic-vertex') uses the provided env snapshot", async () => {
    const resolved = resolveEnvApiKey("anthropic-vertex", {
      GOOGLE_CLOUD_PROJECT_ID: "vertex-project",
    } as NodeJS.ProcessEnv);

    expect(resolved).toBeNull();
  });

  it("resolveEnvApiKey('anthropic-vertex') accepts GOOGLE_APPLICATION_CREDENTIALS with project_id", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-adc-"));
    const credentialsPath = path.join(tempDir, "adc.json");
    await fs.writeFile(credentialsPath, JSON.stringify({ project_id: "vertex-project" }), "utf8");

    try {
      const resolved = resolveEnvApiKey("anthropic-vertex", {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      } as NodeJS.ProcessEnv);

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("resolveEnvApiKey('anthropic-vertex') accepts GOOGLE_APPLICATION_CREDENTIALS without a local project field", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-adc-"));
    const credentialsPath = path.join(tempDir, "adc.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");

    try {
      const resolved = resolveEnvApiKey("anthropic-vertex", {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      } as NodeJS.ProcessEnv);

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("resolveEnvApiKey('anthropic-vertex') accepts explicit metadata auth opt-in", async () => {
    const resolved = resolveEnvApiKey("anthropic-vertex", {
      ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
    } as NodeJS.ProcessEnv);

    expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
    expect(resolved?.source).toBe("gcloud adc");
  });
});
