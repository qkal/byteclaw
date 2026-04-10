import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    profiles: {},
    version: 1,
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const hasUsableCustomProviderApiKey = vi.hoisted(() => vi.fn(() => false));
vi.mock("../agents/model-auth.js", () => ({
  hasUsableCustomProviderApiKey,
  resolveEnvApiKey,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() =>
  vi.fn(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  }),
);
vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider,
}));

const providerModelPickerContributionRuntime = vi.hoisted(() => ({
  enabled: false,
  resolve: vi.fn(() => []),
}));
const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
const runProviderPluginAuthMethod = vi.hoisted(() => vi.fn());
vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    resolvePluginProviders,
    get resolveProviderModelPickerContributions() {
      return providerModelPickerContributionRuntime.enabled
        ? providerModelPickerContributionRuntime.resolve
        : undefined;
    },
    resolveProviderModelPickerEntries,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    runProviderPluginAuthMethod,
  },
}));

const OPENROUTER_CATALOG = [
  {
    id: "auto",
    name: "OpenRouter Auto",
    provider: "openrouter",
  },
  {
    id: "meta-llama/llama-3.3-70b:free",
    name: "Llama 3.3 70B",
    provider: "openrouter",
  },
] as const;

function expectRouterModelFiltering(options: { value: string }[]) {
  expect(options.some((opt) => opt.value === "openrouter/auto")).toBe(false);
  expect(options.some((opt) => opt.value === "openrouter/meta-llama/llama-3.3-70b:free")).toBe(
    true,
  );
}

function createSelectAllMultiselect() {
  return vi.fn(async (params) => params.options.map((option: { value: string }) => option.value));
}

beforeEach(() => {
  vi.clearAllMocks();
  providerModelPickerContributionRuntime.enabled = false;
  resolveOwningPluginIdsForProvider.mockImplementation(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  });
});

describe("promptDefaultModel", () => {
  it("adds auth-route hints for OpenAI API and Codex OAuth models", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai-codex",
      },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      allowKeep: false,
      config: { agents: { defaults: {} } } as OpenClawConfig,
      ignoreAllowlist: true,
      includeManual: false,
      prompter,
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hint: expect.stringContaining("API key route"),
          value: "openai/gpt-5.4",
        }),
        expect.objectContaining({
          hint: expect.stringContaining("ChatGPT OAuth route"),
          value: "openai-codex/gpt-5.4",
        }),
      ]),
    );
  });

  it("treats byteplus plan models as preferred-provider matches", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
      },
      {
        id: "ark-code-latest",
        name: "Ark Coding Plan",
        provider: "byteplus-plan",
      },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
    } as OpenClawConfig;

    const result = await promptDefaultModel({
      allowKeep: true,
      config,
      ignoreAllowlist: true,
      includeManual: false,
      preferredProvider: "byteplus",
      prompter,
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    const optionValues = options.map((opt: { value: string }) => opt.value);
    expect(optionValues).toContain("byteplus-plan/ark-code-latest");
    expect(optionValues[1]).toBe("byteplus-plan/ark-code-latest");
    expect(select.mock.calls[0]?.[0]?.initialValue).toBe("byteplus-plan/ark-code-latest");
    expect(result.model).toBe("byteplus-plan/ark-code-latest");
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "byteplus" }),
    );
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "byteplus-plan" }),
    );
  });

  it("supports configuring vLLM during setup", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
    ]);
    resolveProviderModelPickerEntries.mockReturnValue([
      { hint: "Enter vLLM URL + API key + model", label: "vLLM (custom)", value: "vllm" },
    ] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      method: { id: "custom", kind: "custom", label: "vLLM" },
      provider: { auth: [], id: "vllm", label: "vLLM" },
    });
    runProviderPluginAuthMethod.mockResolvedValue({
      config: {
        models: {
          providers: {
            vllm: {
              api: "openai-completions",
              apiKey: "VLLM_API_KEY",
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [
                {
                  id: "meta-llama/Meta-Llama-3-8B-Instruct",
                  name: "meta-llama/Meta-Llama-3-8B-Instruct",
                },
              ],
            },
          },
        },
      },
      defaultModel: "vllm/meta-llama/Meta-Llama-3-8B-Instruct",
    });

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "vllm");
      return (vllm?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptDefaultModel({
      agentDir: "/tmp/openclaw-agent",
      allowKeep: false,
      config,
      ignoreAllowlist: true,
      includeManual: false,
      includeProviderPluginSetups: true,
      prompter,
      runtime: {} as never,
    });

    expect(runProviderPluginAuthMethod).toHaveBeenCalledOnce();
    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config,
      env: undefined,
      mode: "setup",
      workspaceDir: undefined,
    });
    expect(result.model).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
    expect(result.config?.models?.providers?.vllm).toMatchObject({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY", // Pragma: allowlist secret
      models: [
        { id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "meta-llama/Meta-Llama-3-8B-Instruct" },
      ],
    });
  });

  it("prefers provider model-picker contributions when the runtime exposes them", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
      },
    ]);
    providerModelPickerContributionRuntime.enabled = true;
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        id: "provider:model-picker:ollama",
        kind: "provider",
        option: {
          hint: "Local/self-hosted setup",
          label: "Ollama",
          value: "ollama",
        },
        surface: "model-picker",
      },
    ] as never);
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        hint: "Should not be used when contributions exist",
        label: "Legacy entry",
        value: "legacy-entry",
      },
    ] as never);

    const select = vi.fn(async (params) => {
      const ollama = params.options.find((opt: { value: string }) => opt.value === "ollama");
      return (ollama?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });

    await promptDefaultModel({
      agentDir: "/tmp/openclaw-agent",
      allowKeep: false,
      config: { agents: { defaults: {} } } as OpenClawConfig,
      ignoreAllowlist: true,
      includeManual: false,
      includeProviderPluginSetups: true,
      prompter,
      runtime: {} as never,
    });

    expect(providerModelPickerContributionRuntime.resolve).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[0]?.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Ollama", value: "ollama" })]),
    );
    expect(select.mock.calls[0]?.[0]?.options).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "legacy-entry" })]),
    );
  });
});

describe("promptModelAllowlist", () => {
  it("filters to allowed keys when provided", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.5",
        provider: "anthropic",
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.2",
        provider: "openai",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      allowedKeys: ["anthropic/claude-opus-4-6"],
      config,
      prompter,
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "anthropic/claude-opus-4-6",
    ]);
  });

  it("scopes the initial allowlist picker to the preferred provider", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        provider: "openai",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      config,
      preferredProvider: "openai",
      prompter,
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
    ]);
  });
});

describe("router model filtering", () => {
  it("filters internal router models in both default and allowlist prompts", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const multiselect = createSelectAllMultiselect();
    const defaultPrompter = makePrompter({ select });
    const allowlistPrompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptDefaultModel({
      allowKeep: false,
      config,
      ignoreAllowlist: true,
      includeManual: false,
      prompter: defaultPrompter,
    });
    await promptModelAllowlist({ config, prompter: allowlistPrompter });

    const defaultOptions = select.mock.calls[0]?.[0]?.options ?? [];
    expectRouterModelFiltering(defaultOptions);

    const allowlistCall = multiselect.mock.calls[0]?.[0];
    expectRouterModelFiltering(allowlistCall?.options as { value: string }[]);
    expect(allowlistCall?.searchable).toBe(true);
    expect(runProviderPluginAuthMethod).not.toHaveBeenCalled();
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "openai/gpt-5.4": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.4"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.4": { alias: "gpt" },
    });
  });

  it("clears the allowlist when no models remain", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, []);
    expect(next.agents?.defaults?.models).toBeUndefined();
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      fallbacks: ["anthropic/claude-sonnet-4-6"],
      primary: "anthropic/claude-opus-4-6",
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { fallbacks: ["openai/gpt-5.4"], primary: "anthropic/claude-opus-4-6" },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.4"]);
    expect(next.agents?.defaults?.model).toEqual({
      fallbacks: ["openai/gpt-5.4"],
      primary: "anthropic/claude-opus-4-6",
    });
  });
});
