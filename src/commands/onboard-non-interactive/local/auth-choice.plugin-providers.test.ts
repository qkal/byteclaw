import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));
const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  authChoicePluginProvidersRuntime: {
    resolveOwningPluginIdsForProvider,
    resolvePluginProviders,
    resolveProviderPluginChoice,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
  resolveManifestProviderAuthChoice.mockReturnValue(undefined);
  resolveOwningPluginIdsForProvider.mockReturnValue(undefined as never);
  resolveProviderPluginChoice.mockReturnValue(undefined);
  resolvePluginProviders.mockReturnValue([] as never);
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("applyNonInteractivePluginProviderChoice", () => {
  it("loads plugin providers for provider-plugin auth choices", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["vllm"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["vllm"] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm", pluginId: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      method: { runNonInteractive },
      provider: { id: "vllm", label: "vLLM", pluginId: "vllm" },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      authChoice: "provider-plugin:vllm:custom",
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      opts: {} as never,
      resolveApiKey: vi.fn(),
      runtime: runtime as never,
      toApiKeyCredential: vi.fn(),
    });

    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledOnce();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vllm",
      }),
    );
    expect(resolvePluginProviders).toHaveBeenCalledOnce();
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
        onlyPluginIds: ["vllm"],
      }),
    );
    expect(resolveProviderPluginChoice).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toEqual({ plugins: { allow: ["vllm"] } });
  });

  it("fails explicitly when a provider-plugin auth choice resolves to no trusted setup provider", async () => {
    const runtime = createRuntime();

    const result = await applyNonInteractivePluginProviderChoice({
      authChoice: "provider-plugin:workspace-provider:api-key",
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      opts: {} as never,
      resolveApiKey: vi.fn(),
      runtime: runtime as never,
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Auth choice "provider-plugin:workspace-provider:api-key" was not matched to a trusted provider plugin.',
      ),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails explicitly when a non-prefixed auth choice resolves only with untrusted providers", async () => {
    const runtime = createRuntime();
    resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
    resolveManifestProviderAuthChoice.mockReturnValueOnce(undefined).mockReturnValueOnce({
      pluginId: "workspace-provider",
      providerId: "workspace-provider",
    } as never);

    const result = await applyNonInteractivePluginProviderChoice({
      authChoice: "workspace-provider-api-key",
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      opts: {} as never,
      resolveApiKey: vi.fn(),
      runtime: runtime as never,
      toApiKeyCredential: vi.fn(),
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Auth choice "workspace-provider-api-key" matched a provider plugin that is not trusted or enabled for setup.',
      ),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolveProviderPluginChoice).toHaveBeenCalledTimes(1);
    expect(resolvePluginProviders).toHaveBeenCalledTimes(1);
    expect(resolveManifestProviderAuthChoice).toHaveBeenCalledWith(
      "workspace-provider-api-key",
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolveManifestProviderAuthChoice).toHaveBeenCalledWith(
      "workspace-provider-api-key",
      expect.objectContaining({
        config: expect.objectContaining({ agents: { defaults: {} } }),
        includeUntrustedWorkspacePlugins: true,
        workspaceDir: expect.any(String),
      }),
    );
  });

  it("limits setup-provider resolution to owning plugin ids without pre-enabling them", async () => {
    const runtime = createRuntime();
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["demo-plugin"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["demo-plugin"] as never);
    resolvePluginProviders.mockReturnValue([
      { id: "demo-provider", pluginId: "demo-plugin" },
    ] as never);
    resolveProviderPluginChoice.mockReturnValue({
      method: { runNonInteractive },
      provider: { id: "demo-provider", label: "Demo Provider", pluginId: "demo-plugin" },
    });

    const result = await applyNonInteractivePluginProviderChoice({
      authChoice: "provider-plugin:demo-provider:custom",
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      opts: {} as never,
      resolveApiKey: vi.fn(),
      runtime: runtime as never,
      toApiKeyCredential: vi.fn(),
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ agents: { defaults: {} } }),
        includeUntrustedWorkspacePlugins: false,
        onlyPluginIds: ["demo-plugin"],
      }),
    );
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toEqual({ plugins: { allow: ["demo-plugin"] } });
  });

  it("filters untrusted workspace manifest choices when resolving inferred auth choices", async () => {
    const runtime = createRuntime();
    resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);

    await applyNonInteractivePluginProviderChoice({
      authChoice: "openai-api-key",
      baseConfig: { agents: { defaults: {} } } as OpenClawConfig,
      nextConfig: { agents: { defaults: {} } } as OpenClawConfig,
      opts: {} as never,
      resolveApiKey: vi.fn(),
      runtime: runtime as never,
      toApiKeyCredential: vi.fn(),
    });

    expect(resolvePreferredProviderForAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: "openai-api-key",
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
  });
});
