import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function createTestProvider(params: {
  id: WebProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const readSearchConfigKey = (searchConfig?: Record<string, unknown>): unknown => {
    const providerConfig =
      searchConfig?.[params.id] && typeof searchConfig[params.id] === "object"
        ? (searchConfig[params.id] as { apiKey?: unknown })
        : undefined;
    return providerConfig?.apiKey ?? searchConfig?.apiKey;
  };
  return {
    autoDetectOrder: params.order,
    createTool: () => null,
    credentialPath,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    getConfiguredCredentialValue: (config) =>
      (config?.plugins?.entries?.[params.pluginId]?.config as { webSearch?: { apiKey?: unknown } })
        ?.webSearch?.apiKey,
    getCredentialValue: readSearchConfigKey,
    hint: `${params.id} test provider`,
    id: params.id,
    inactiveSecretPaths: [credentialPath],
    label: params.id,
    placeholder: `${params.id}-...`,
    pluginId: params.pluginId,
    resolveRuntimeMetadata:
      params.id === "perplexity"
        ? () => ({
            perplexityTransport: "search_api" as const,
          })
        : undefined,
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
      const entries = (plugins.entries ??= {});
      const entry = (entries[params.pluginId] ??= {}) as { config?: Record<string, unknown> };
      const config = (entry.config ??= {});
      const webSearch = (config.webSearch ??= {}) as { apiKey?: unknown };
      webSearch.apiKey = value;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const providerConfig =
        params.id === "brave" || params.id === "firecrawl"
          ? searchConfigTarget
          : ((searchConfigTarget[params.id] ??= {}) as { apiKey?: unknown });
      providerConfig.apiKey = value;
    },
    signupUrl: `https://example.com/${params.id}`,
  };
}

function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider({ id: "brave", order: 10, pluginId: "brave" }),
    createTestProvider({ id: "gemini", order: 20, pluginId: "google" }),
    createTestProvider({ id: "grok", order: 30, pluginId: "xai" }),
    createTestProvider({ id: "kimi", order: 40, pluginId: "moonshot" }),
    createTestProvider({ id: "perplexity", order: 50, pluginId: "perplexity" }),
    createTestProvider({ id: "firecrawl", order: 60, pluginId: "firecrawl" }),
  ];
}

function createOpenAiFileModelsConfig(): NonNullable<OpenClawConfig["models"]> {
  return {
    providers: {
      openai: {
        apiKey: { id: "/providers/openai/apiKey", provider: "default", source: "file" },
        baseUrl: "https://api.openai.com/v1",
        models: [],
      },
    },
  };
}

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("secrets runtime provider and media surfaces", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("resolves file refs via configured file provider", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-file-provider-"));
    const secretsPath = path.join(root, "secrets.json");
    try {
      await fs.writeFile(
        secretsPath,
        JSON.stringify(
          {
            providers: {
              openai: {
                apiKey: "sk-from-file-provider",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.chmod(secretsPath, 0o600);

      const config = asConfig({
        models: {
          providers: {
            openai: {
              apiKey: { id: "/providers/openai/apiKey", provider: "default", source: "file" },
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
        secrets: {
          defaults: {
            file: "default",
          },
          providers: {
            default: {
              mode: "json",
              path: secretsPath,
              source: "file",
            },
          },
        },
      });

      const snapshot = await prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config,
        loadAuthStore: () => ({ profiles: {}, version: 1 }),
      });

      expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-from-file-provider");
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("fails when file provider payload is not a JSON object", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-secrets-file-provider-bad-"));
    const secretsPath = path.join(root, "secrets.json");
    try {
      await fs.writeFile(secretsPath, JSON.stringify(["not-an-object"]), "utf8");
      await fs.chmod(secretsPath, 0o600);

      await expect(
        prepareSecretsRuntimeSnapshot({
          agentDirs: ["/tmp/openclaw-agent-main"],
          config: asConfig({
            models: {
              ...createOpenAiFileModelsConfig(),
            },
            secrets: {
              providers: {
                default: {
                  mode: "json",
                  path: secretsPath,
                  source: "file",
                },
              },
            },
          }),
          loadAuthStore: () => ({ profiles: {}, version: 1 }),
        }),
      ).rejects.toThrow("payload is not a JSON object");
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it("resolves shared media model request refs when capability blocks are omitted", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                capabilities: ["audio"],
                model: "gpt-4o-mini-transcribe",
                provider: "openai",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: {
                      id: "MEDIA_SHARED_AUDIO_TOKEN",
                      provider: "default",
                      source: "env",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_SHARED_AUDIO_TOKEN: "shared-audio-token",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "shared-audio-token",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats shared media model request refs as inactive when their capabilities are disabled", async () => {
    const sharedTokenRef = {
      id: "MEDIA_DISABLED_AUDIO_TOKEN",
      provider: "default" as const,
      source: "env" as const,
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        tools: {
          media: {
            audio: {
              enabled: false,
            },
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: sharedTokenRef,
                  },
                },
              },
            ],
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: sharedTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("resolves shared media model request refs from inferred provider capabilities", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram Plugin",
      provider: {
        capabilities: ["audio"],
        id: "deepgram",
      },
      source: "test",
    });
    setActivePluginRegistry(pluginRegistry);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        tools: {
          media: {
            models: [
              {
                provider: "deepgram",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: {
                      id: "MEDIA_INFERRED_AUDIO_TOKEN",
                      provider: "default",
                      source: "env",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_INFERRED_AUDIO_TOKEN: "inferred-audio-token",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "inferred-audio-token",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats shared media model request refs as inactive when inferred capabilities are disabled", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "deepgram",
      pluginName: "Deepgram Plugin",
      provider: {
        capabilities: ["audio"],
        id: "deepgram",
      },
      source: "test",
    });
    setActivePluginRegistry(pluginRegistry);

    const inferredTokenRef = {
      id: "MEDIA_INFERRED_DISABLED_AUDIO_TOKEN",
      provider: "default" as const,
      source: "env" as const,
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        tools: {
          media: {
            audio: {
              enabled: false,
            },
            models: [
              {
                provider: "deepgram",
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: inferredTokenRef,
                  },
                },
              },
            ],
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.tools?.media?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: inferredTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.models.0.request.auth.token",
    );
  });

  it("treats section media model request refs as inactive when model capabilities exclude the section", async () => {
    const sectionTokenRef = {
      id: "MEDIA_AUDIO_SECTION_FILTERED_TOKEN",
      provider: "default" as const,
      source: "env" as const,
    };
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        tools: {
          media: {
            audio: {
              enabled: true,
              models: [
                {
                  capabilities: ["video"],
                  provider: "openai",
                  request: {
                    auth: {
                      mode: "authorization-bearer",
                      token: sectionTokenRef,
                    },
                  },
                },
              ],
            },
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.tools?.media?.audio?.models?.[0]?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: sectionTokenRef,
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "tools.media.audio.models.0.request.auth.token",
    );
  });

  it("treats defaults memorySearch ref as inactive when all enabled agents disable memorySearch", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: {
                  id: "DEFAULT_MEMORY_REMOTE_API_KEY",
                  provider: "default",
                  source: "env",
                },
              },
            },
          },
          list: [
            {
              enabled: true,
              memorySearch: {
                enabled: false,
              },
            },
          ],
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toEqual({
      id: "DEFAULT_MEMORY_REMOTE_API_KEY",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "agents.defaults.memorySearch.remote.apiKey",
    );
  });
});
