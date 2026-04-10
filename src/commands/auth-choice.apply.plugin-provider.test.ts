import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAuthChoiceLoadedPluginProvider,
  applyAuthChoicePluginProvider,
  runProviderPluginAuthMethod,
} from "../plugins/provider-auth-choice.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<() => { provider: ProviderPlugin; method: ProviderAuthMethod } | null>(),
);
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
}));

const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfile,
}));

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "default"));
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

const resolveDefaultAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir,
}));

const resolveOpenClawAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir,
}));

const applyAuthProfileConfig = vi.hoisted(() => vi.fn((config) => config));
vi.mock("../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig,
}));

const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/setup-browser.js", () => ({
  isRemoteEnvironment,
  openUrl,
}));

const createVpsAwareOAuthHandlers = vi.hoisted(() => vi.fn());
vi.mock("../plugins/provider-oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers,
}));

function buildProvider(): ProviderPlugin {
  return {
    auth: [
      {
        id: "local",
        kind: "custom",
        label: "Ollama",
        run: async () => ({
          profiles: [
            {
              profileId: "ollama:default",
              credential: {
                type: "api_key",
                provider: "ollama",
                key: "ollama-local",
              },
            },
          ],
          defaultModel: "ollama/qwen3:4b",
        }),
      },
    ],
    id: "ollama",
    label: "Ollama",
  };
}

function buildParams(overrides: Partial<ApplyAuthChoiceParams> = {}): ApplyAuthChoiceParams {
  return {
    authChoice: "ollama",
    config: {},
    prompter: {
      note: vi.fn(async () => {}),
    } as unknown as ApplyAuthChoiceParams["prompter"],
    runtime: {} as ApplyAuthChoiceParams["runtime"],
    setDefaultModel: true,
    ...overrides,
  };
}

describe("applyAuthChoiceLoadedPluginProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAuthProfileConfig.mockImplementation((config) => config);
  });

  it("returns an agent model override when default model application is deferred", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      method: provider.auth[0],
      provider,
    });

    const result = await applyAuthChoiceLoadedPluginProvider(
      buildParams({
        setDefaultModel: false,
      }),
    );

    expect(result).toEqual({
      agentModelOverride: "ollama/qwen3:4b",
      config: {},
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
  });

  it("applies the default model and runs provider post-setup hooks", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      method: provider.auth[0],
      provider,
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen3:4b",
    });
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      credential: {
        key: "ollama-local",
        provider: "ollama",
        type: "api_key",
      },
      profileId: "ollama:default",
    });
    expect(runProviderModelSelectedHook).toHaveBeenCalledWith({
      agentDir: undefined,
      config: result?.config,
      model: "ollama/qwen3:4b",
      prompter: expect.objectContaining({ note: expect.any(Function) }),
      workspaceDir: "/tmp/workspace",
    });
  });

  it("merges provider config patches and emits provider notes", async () => {
    applyAuthProfileConfig.mockImplementation(((
      config: {
        auth?: {
          profiles?: Record<string, { provider: string; mode: string }>;
        };
      },
      profile: { profileId: string; provider: string; mode: string },
    ) => ({
      ...config,
      auth: {
        profiles: {
          ...config.auth?.profiles,
          [profile.profileId]: {
            mode: profile.mode,
            provider: profile.provider,
          },
        },
      },
    })) as never);

    const note = vi.fn(async () => {});
    const method: ProviderAuthMethod = {
      id: "local",
      kind: "custom",
      label: "Local",
      run: async () => ({
        configPatch: {
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
        defaultModel: "ollama/qwen3:4b",
        notes: ["Detected local Ollama runtime.", "Pulled model metadata."],
        profiles: [
          {
            profileId: "ollama:default",
            credential: {
              type: "api_key",
              provider: "ollama",
              key: "ollama-local",
            },
          },
        ],
      }),
    };

    const result = await runProviderPluginAuthMethod({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      },
      method,
      prompter: {
        note,
      } as unknown as ApplyAuthChoiceParams["prompter"],
      runtime: {} as ApplyAuthChoiceParams["runtime"],
    });

    expect(result.defaultModel).toBe("ollama/qwen3:4b");
    expect(result.config.models?.providers?.ollama).toEqual({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [],
    });
    expect(result.config.auth?.profiles?.["ollama:default"]).toEqual({
      mode: "api_key",
      provider: "ollama",
    });
    expect(note).toHaveBeenCalledWith(
      "Detected local Ollama runtime.\nPulled model metadata.",
      "Provider notes",
    );
  });

  it("replaces provider-owned default model maps during auth migrations", async () => {
    const method: ProviderAuthMethod = {
      id: "local",
      kind: "custom",
      label: "Local",
      run: async () => ({
        configPatch: {
          agents: {
            defaults: {
              model: {
                fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
                primary: "claude-cli/claude-sonnet-4-6",
              },
              models: {
                "claude-cli/claude-opus-4-6": { alias: "Opus" },
                "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
                "openai/gpt-5.2": {},
              },
            },
          },
        },
        defaultModel: "claude-cli/claude-sonnet-4-6",
        profiles: [],
      }),
    };

    const result = await runProviderPluginAuthMethod({
      config: {
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
              primary: "anthropic/claude-sonnet-4-6",
            },
            models: {
              "anthropic/claude-opus-4-6": { alias: "Opus" },
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
              "openai/gpt-5.2": {},
            },
          },
        },
      },
      method,
      prompter: {
        note: vi.fn(async () => {}),
      } as unknown as ApplyAuthChoiceParams["prompter"],
      runtime: {} as ApplyAuthChoiceParams["runtime"],
    });

    expect(result.config.agents?.defaults?.model).toEqual({
      fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
      primary: "claude-cli/claude-sonnet-4-6",
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "openai/gpt-5.2": {},
    });
  });

  it("returns an agent-scoped override for plugin auth choices when default model application is deferred", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);

    const note = vi.fn(async () => {});
    const result = await applyAuthChoicePluginProvider(
      buildParams({
        agentId: "worker",
        authChoice: "provider-plugin:ollama:local",
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
        setDefaultModel: false,
      }),
      {
        authChoice: "provider-plugin:ollama:local",
        label: "Ollama",
        methodId: "local",
        pluginId: "ollama",
        providerId: "ollama",
      },
    );

    expect(result?.agentModelOverride).toBe("ollama/qwen3:4b");
    expect(result?.config.plugins).toEqual({
      entries: {
        ollama: {
          enabled: true,
        },
      },
    });
    expect(runProviderModelSelectedHook).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      'Default model set to ollama/qwen3:4b for agent "worker".',
      "Model configured",
    );
  });

  it("stops early when the plugin is disabled in config", async () => {
    const note = vi.fn(async () => {});

    const result = await applyAuthChoicePluginProvider(
      buildParams({
        config: {
          plugins: {
            enabled: false,
          },
        },
        prompter: {
          note,
        } as unknown as ApplyAuthChoiceParams["prompter"],
      }),
      {
        authChoice: "ollama",
        label: "Ollama",
        pluginId: "ollama",
        providerId: "ollama",
      },
    );

    expect(result).toEqual({
      config: {
        plugins: {
          enabled: false,
        },
      },
    });
    expect(resolvePluginProviders).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith("Ollama plugin is disabled (plugins disabled).", "Ollama");
  });
});
