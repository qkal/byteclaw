import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice,
  resolveProviderWizardOptions,
  runProviderModelSelectedHook,
} from "./provider-wizard.js";
import type { ProviderPlugin } from "./types.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("./providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
  resolvePluginProviders,
}));

const DEFAULT_WORKSPACE_DIR = "/tmp/workspace";

function makeProvider(overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id" | "label">) {
  return {
    auth: [],
    ...overrides,
  } satisfies ProviderPlugin;
}

function createSglangWizardProvider(params?: {
  includeSetup?: boolean;
  includeModelPicker?: boolean;
}) {
  return makeProvider({
    auth: [{ id: "server", kind: "custom", label: "Server", run: vi.fn() }],
    id: "sglang",
    label: "SGLang",
    wizard: {
      ...((params?.includeSetup ?? true)
        ? {
            setup: {
              choiceLabel: "SGLang setup",
              groupId: "sglang",
              groupLabel: "SGLang",
            },
          }
        : {}),
      ...(params?.includeModelPicker
        ? {
            modelPicker: {
              label: "SGLang server",
              methodId: "server",
            },
          }
        : {}),
    },
  });
}

function createSglangConfig() {
  return {
    plugins: {
      allow: ["sglang"],
    },
  };
}

function createHomeEnv(suffix = "", overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: `/tmp/openclaw-home${suffix}`,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createWizardRuntimeParams(params?: {
  config?: object;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}) {
  return {
    config: params?.config ?? createSglangConfig(),
    env: params?.env ?? createHomeEnv(),
    workspaceDir: params?.workspaceDir ?? DEFAULT_WORKSPACE_DIR,
  };
}

function expectProviderResolutionCall(params?: {
  config?: object;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  count?: number;
}) {
  expect(resolvePluginProviders).toHaveBeenCalledTimes(params?.count ?? 1);
  expect(resolvePluginProviders).toHaveBeenCalledWith({
    ...createWizardRuntimeParams(params),
    mode: "setup",
  });
}

function setResolvedProviders(...providers: ProviderPlugin[]) {
  resolvePluginProviders.mockReturnValue(providers);
}

function expectSingleWizardChoice(params: {
  provider: ProviderPlugin;
  choice: string;
  expectedOption: Record<string, unknown>;
  expectedWizard: unknown;
}) {
  setResolvedProviders(params.provider);
  expect(resolveProviderWizardOptions({})).toEqual([params.expectedOption]);
  expect(
    resolveProviderPluginChoice({
      choice: params.choice,
      providers: [params.provider],
    }),
  ).toEqual({
    method: params.provider.auth[0],
    provider: params.provider,
    wizard: params.expectedWizard,
  });
}

function expectModelPickerEntries(
  provider: ProviderPlugin,
  expected: {
    value: string;
    label: string;
    hint?: string;
  }[],
) {
  setResolvedProviders(provider);
  expect(resolveProviderModelPickerEntries({})).toEqual(expected);
}

describe("provider wizard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    {
      choice: "self-hosted-vllm",
      expectedOption: {
        groupId: "local-runtimes",
        groupLabel: "Local runtimes",
        label: "vLLM local",
        value: "self-hosted-vllm",
      },
      name: "uses explicit setup choice ids and bound method ids",
      provider: makeProvider({
        auth: [
          { id: "local", label: "Local", kind: "custom", run: vi.fn() },
          { id: "cloud", label: "Cloud", kind: "custom", run: vi.fn() },
        ],
        id: "vllm",
        label: "vLLM",
        wizard: {
          setup: {
            choiceId: "self-hosted-vllm",
            choiceLabel: "vLLM local",
            groupId: "local-runtimes",
            groupLabel: "Local runtimes",
            methodId: "local",
          },
        },
      }),
      resolveWizard: (provider: ProviderPlugin) => provider.wizard?.setup,
    },
    {
      choice: "openai-api-key",
      expectedOption: {
        groupId: "openai",
        groupLabel: "OpenAI",
        label: "OpenAI API key",
        onboardingScopes: ["text-inference"],
        value: "openai-api-key",
      },
      name: "builds wizard options from method-level metadata",
      provider: makeProvider({
        auth: [
          {
            id: "api-key",
            label: "OpenAI API key",
            kind: "api_key",
            wizard: {
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              groupId: "openai",
              groupLabel: "OpenAI",
              onboardingScopes: ["text-inference"],
            },
            run: vi.fn(),
          },
        ],
        id: "openai",
        label: "OpenAI",
      }),
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
    {
      choice: "fal-api-key",
      expectedOption: {
        groupId: "fal",
        groupLabel: "fal",
        label: "fal API key",
        onboardingScopes: ["image-generation"],
        value: "fal-api-key",
      },
      name: "preserves onboarding scopes on wizard options",
      provider: makeProvider({
        auth: [
          {
            id: "api-key",
            label: "fal API key",
            kind: "api_key",
            wizard: {
              choiceId: "fal-api-key",
              choiceLabel: "fal API key",
              groupId: "fal",
              groupLabel: "fal",
              onboardingScopes: ["image-generation"],
            },
            run: vi.fn(),
          },
        ],
        id: "fal",
        label: "fal",
      }),
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
    {
      choice: "anthropic-cli",
      expectedOption: {
        groupHint: undefined,
        groupId: "anthropic",
        groupLabel: "Anthropic",
        hint: undefined,
        label: "Anthropic",
        value: "anthropic-cli",
      },
      name: "returns method wizard metadata for canonical choices",
      provider: makeProvider({
        auth: [
          {
            id: "cli",
            label: "Claude CLI",
            kind: "custom",
            wizard: {
              choiceId: "anthropic-cli",
              modelAllowlist: {
                allowedKeys: ["claude-cli/claude-sonnet-4-6"],
                initialSelections: ["claude-cli/claude-sonnet-4-6"],
                message: "Claude CLI models",
              },
            },
            run: vi.fn(),
          },
        ],
        id: "anthropic",
        label: "Anthropic",
      }),
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
  ] as const)("$name", ({ provider, choice, expectedOption, resolveWizard }) => {
    expectSingleWizardChoice({
      choice,
      expectedOption,
      expectedWizard: resolveWizard(provider),
      provider,
    });
  });

  it("builds model-picker entries from plugin metadata and provider-method choices", () => {
    const provider = makeProvider({
      auth: [
        { id: "server", kind: "custom", label: "Server", run: vi.fn() },
        { id: "cloud", kind: "custom", label: "Cloud", run: vi.fn() },
      ],
      id: "sglang",
      label: "SGLang",
      wizard: {
        modelPicker: {
          hint: "OpenAI-compatible local runtime",
          label: "SGLang server",
          methodId: "server",
        },
      },
    });
    expectModelPickerEntries(provider, [
      {
        hint: "OpenAI-compatible local runtime",
        label: "SGLang server",
        value: buildProviderPluginMethodChoice("sglang", "server"),
      },
    ]);
  });

  it("resolves providers in setup mode across wizard consumers", () => {
    const provider = createSglangWizardProvider({ includeModelPicker: true });
    const config = {};
    const env = createHomeEnv();
    setResolvedProviders(provider);

    const runtimeParams = createWizardRuntimeParams({ config, env });
    expect(resolveProviderWizardOptions(runtimeParams)).toHaveLength(1);
    expect(resolveProviderModelPickerEntries(runtimeParams)).toHaveLength(1);

    expectProviderResolutionCall({ config, count: 2, env });
  });

  it("routes model-selected hooks only to the matching provider", async () => {
    const matchingHook = vi.fn(async () => {});
    const otherHook = vi.fn(async () => {});
    setResolvedProviders(
      makeProvider({
        id: "ollama",
        label: "Ollama",
        onModelSelected: otherHook,
      }),
      makeProvider({
        id: "vllm",
        label: "vLLM",
        onModelSelected: matchingHook,
      }),
    );

    const env = createHomeEnv();
    await runProviderModelSelectedHook({
      agentDir: "/tmp/agent",
      config: {},
      env,
      model: "vllm/qwen3-coder",
      prompter: {} as never,
      workspaceDir: "/tmp/workspace",
    });

    expectProviderResolutionCall({
      config: {},
      env,
    });
    expect(matchingHook).toHaveBeenCalledWith({
      agentDir: "/tmp/agent",
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {},
      workspaceDir: "/tmp/workspace",
    });
    expect(otherHook).not.toHaveBeenCalled();
  });
});
