import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderWizardOption } from "../plugins/provider-wizard.js";
import {
  buildAuthChoiceGroups,
  buildAuthChoiceOptions,
  formatAuthChoiceChoicesForCli,
} from "./auth-choice-options.js";
import { formatStaticAuthChoiceChoicesForCli } from "./auth-choice-options.static.js";

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<() => ProviderAuthChoiceMetadata[]>(() => []),
);
const resolveProviderWizardOptions = vi.hoisted(() =>
  vi.fn<() => ProviderWizardOption[]>(() => []),
);

function includesOnboardingScope(
  scopes: readonly ("text-inference" | "image-generation")[] | undefined,
  scope: "text-inference" | "image-generation",
): boolean {
  return scopes ? scopes.includes(scope) : scope === "text-inference";
}

vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: vi.fn(
    (params?: { scope?: "text-inference" | "image-generation" }) => {
      const scope = params?.scope ?? "text-inference";
      return [
        ...resolveManifestProviderAuthChoices()
          .filter((choice) => includesOnboardingScope(choice.onboardingScopes, scope))
          .map((choice) => ({
            option: {
              label: choice.choiceLabel,
              value: choice.choiceId,
              ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
              ...(choice.groupId && choice.groupLabel
                ? {
                    group: {
                      id: choice.groupId,
                      label: choice.groupLabel,
                      ...(choice.groupHint ? { hint: choice.groupHint } : {}),
                    },
                  }
                : {}),
              ...(choice.assistantPriority !== undefined
                ? { assistantPriority: choice.assistantPriority }
                : {}),
              ...(choice.assistantVisibility
                ? { assistantVisibility: choice.assistantVisibility }
                : {}),
            },
          })),
        ...resolveProviderWizardOptions()
          .filter((option) => includesOnboardingScope(option.onboardingScopes, scope))
          .map((option) => ({
            option: {
              value: option.value,
              label: option.label,
              ...(option.hint ? { hint: option.hint } : {}),
              group: {
                id: option.groupId,
                label: option.groupLabel,
                ...(option.groupHint ? { hint: option.groupHint } : {}),
              },
              ...(option.assistantPriority !== undefined
                ? { assistantPriority: option.assistantPriority }
                : {}),
              ...(option.assistantVisibility
                ? { assistantVisibility: option.assistantVisibility }
                : {}),
            },
          })),
      ];
    },
  ),
}));

const EMPTY_STORE: AuthProfileStore = { profiles: {}, version: 1 };

function getOptions(includeSkip = false) {
  return buildAuthChoiceOptions({
    includeSkip,
    store: EMPTY_STORE,
  });
}

describe("buildAuthChoiceOptions", () => {
  beforeEach(() => {
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolveProviderWizardOptions.mockReturnValue([]);
  });

  it("includes core and provider-specific auth choices", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "chutes",
        choiceLabel: "Chutes (OAuth)",
        groupId: "chutes",
        groupLabel: "Chutes",
        methodId: "oauth",
        pluginId: "chutes",
        providerId: "chutes",
      },
      {
        choiceId: "github-copilot",
        choiceLabel: "GitHub Copilot",
        groupId: "copilot",
        groupLabel: "Copilot",
        methodId: "device",
        pluginId: "github-copilot",
        providerId: "github-copilot",
      },
      {
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        methodId: "api-key",
        pluginId: "openai",
        providerId: "openai",
      },
      {
        choiceId: "litellm-api-key",
        choiceLabel: "LiteLLM API key",
        groupId: "litellm",
        groupLabel: "LiteLLM",
        methodId: "api-key",
        pluginId: "litellm",
        providerId: "litellm",
      },
      {
        choiceId: "moonshot-api-key",
        choiceLabel: "Kimi API key (.ai)",
        groupId: "moonshot",
        groupLabel: "Moonshot AI (Kimi K2.5)",
        methodId: "api-key",
        pluginId: "moonshot",
        providerId: "moonshot",
      },
      {
        choiceId: "minimax-global-api",
        choiceLabel: "MiniMax API key (Global)",
        groupId: "minimax",
        groupLabel: "MiniMax",
        methodId: "api-global",
        pluginId: "minimax",
        providerId: "minimax",
      },
      {
        choiceId: "zai-api-key",
        choiceLabel: "Z.AI API key",
        groupId: "zai",
        groupLabel: "Z.AI",
        methodId: "api-key",
        pluginId: "zai",
        providerId: "zai",
      },
      {
        choiceId: "xiaomi-api-key",
        choiceLabel: "Xiaomi API key",
        groupId: "xiaomi",
        groupLabel: "Xiaomi",
        methodId: "api-key",
        pluginId: "xiaomi",
        providerId: "xiaomi",
      },
      {
        choiceId: "together-api-key",
        choiceLabel: "Together AI API key",
        groupId: "together",
        groupLabel: "Together AI",
        methodId: "api-key",
        pluginId: "together",
        providerId: "together",
      },
      {
        choiceId: "xai-api-key",
        choiceLabel: "xAI API key",
        groupId: "xai",
        groupLabel: "xAI (Grok)",
        methodId: "api-key",
        pluginId: "xai",
        providerId: "xai",
      },
      {
        choiceId: "mistral-api-key",
        choiceLabel: "Mistral API key",
        groupId: "mistral",
        groupLabel: "Mistral AI",
        methodId: "api-key",
        pluginId: "mistral",
        providerId: "mistral",
      },
      {
        choiceId: "volcengine-api-key",
        choiceLabel: "Volcano Engine API key",
        groupId: "volcengine",
        groupLabel: "Volcano Engine",
        methodId: "api-key",
        pluginId: "volcengine",
        providerId: "volcengine",
      },
      {
        choiceId: "byteplus-api-key",
        choiceLabel: "BytePlus API key",
        groupId: "byteplus",
        groupLabel: "BytePlus",
        methodId: "api-key",
        pluginId: "byteplus",
        providerId: "byteplus",
      },
      {
        choiceId: "opencode-go",
        choiceLabel: "OpenCode Go catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
        methodId: "api-key",
        pluginId: "opencode-go",
        providerId: "opencode-go",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        groupId: "ollama",
        groupLabel: "Ollama",
        hint: "Cloud and local open models",
        label: "Ollama",
        value: "ollama",
      },
      {
        groupId: "vllm",
        groupLabel: "vLLM",
        hint: "Local/self-hosted OpenAI-compatible server",
        label: "vLLM",
        value: "vllm",
      },
      {
        groupId: "sglang",
        groupLabel: "SGLang",
        hint: "Fast self-hosted OpenAI-compatible server",
        label: "SGLang",
        value: "sglang",
      },
    ]);
    const options = getOptions();

    for (const value of [
      "github-copilot",
      "zai-api-key",
      "xiaomi-api-key",
      "minimax-global-api",
      "moonshot-api-key",
      "together-api-key",
      "chutes",
      "xai-api-key",
      "mistral-api-key",
      "volcengine-api-key",
      "byteplus-api-key",
      "vllm",
      "opencode-go",
      "ollama",
      "sglang",
    ]) {
      expect(options.some((opt) => opt.value === value)).toBe(true);
    }
  });

  it("builds cli help choices from the same runtime catalog", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "chutes",
        choiceLabel: "Chutes (OAuth)",
        methodId: "oauth",
        pluginId: "chutes",
        providerId: "chutes",
      },
      {
        choiceId: "litellm-api-key",
        choiceLabel: "LiteLLM API key",
        methodId: "api-key",
        pluginId: "litellm",
        providerId: "litellm",
      },
      {
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        methodId: "api-key",
        pluginId: "openai",
        providerId: "openai",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        groupId: "ollama",
        groupLabel: "Ollama",
        hint: "Cloud and local open models",
        label: "Ollama",
        value: "ollama",
      },
    ]);
    const options = getOptions(true);
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: false,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("openai-api-key");
    expect(cliChoices).toContain("chutes");
    expect(cliChoices).toContain("litellm-api-key");
    expect(cliChoices).toContain("custom-api-key");
    expect(cliChoices).toContain("skip");
    expect(options.some((option) => option.value === "ollama")).toBe(true);
    expect(cliChoices).toContain("ollama");
  });

  it("can include legacy aliases in cli help choices", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "anthropic-cli",
        choiceLabel: "Anthropic Claude CLI",
        deprecatedChoiceIds: ["claude-cli"],
        methodId: "cli",
        pluginId: "anthropic",
        providerId: "anthropic",
      },
      {
        choiceId: "openai-codex",
        choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
        deprecatedChoiceIds: ["codex-cli"],
        methodId: "oauth",
        pluginId: "openai",
        providerId: "openai-codex",
      },
    ]);

    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: true,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("claude-cli");
    expect(cliChoices).toContain("codex-cli");
  });

  it("keeps static cli help choices off the plugin-backed catalog", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        methodId: "api-key",
        pluginId: "openai",
        providerId: "openai",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        groupId: "ollama",
        groupLabel: "Ollama",
        hint: "Cloud and local open models",
        label: "Ollama",
        value: "ollama",
      },
    ]);

    const cliChoices = formatStaticAuthChoiceChoicesForCli({
      includeLegacyAliases: false,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).not.toContain("ollama");
    expect(cliChoices).not.toContain("openai-api-key");
    expect(cliChoices).not.toContain("chutes");
    expect(cliChoices).not.toContain("litellm-api-key");
    expect(cliChoices).toContain("custom-api-key");
    expect(cliChoices).toContain("skip");
  });

  it("shows Chutes in grouped provider selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "chutes",
        choiceLabel: "Chutes (OAuth)",
        groupId: "chutes",
        groupLabel: "Chutes",
        methodId: "oauth",
        pluginId: "chutes",
        providerId: "chutes",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      store: EMPTY_STORE,
    });
    const chutesGroup = groups.find((group) => group.value === "chutes");

    expect(chutesGroup).toBeDefined();
    expect(chutesGroup?.options.some((opt) => opt.value === "chutes")).toBe(true);
  });

  it("shows LiteLLM in grouped provider selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "litellm-api-key",
        choiceLabel: "LiteLLM API key",
        groupId: "litellm",
        groupLabel: "LiteLLM",
        methodId: "api-key",
        pluginId: "litellm",
        providerId: "litellm",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      store: EMPTY_STORE,
    });
    const litellmGroup = groups.find((group) => group.value === "litellm");

    expect(litellmGroup).toBeDefined();
    expect(litellmGroup?.options.some((opt) => opt.value === "litellm-api-key")).toBe(true);
  });

  it("prefers Anthropic Claude CLI over API key in grouped selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "apiKey",
        choiceLabel: "Anthropic API key",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        methodId: "api-key",
        pluginId: "anthropic",
        providerId: "anthropic",
      },
      {
        assistantPriority: -20,
        choiceId: "anthropic-cli",
        choiceLabel: "Anthropic Claude CLI",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        methodId: "cli",
        pluginId: "anthropic",
        providerId: "anthropic",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      store: EMPTY_STORE,
    });
    const anthropicGroup = groups.find((group) => group.value === "anthropic");

    expect(anthropicGroup).toBeDefined();
    expect(anthropicGroup?.options.map((option) => option.value)).toEqual([
      "anthropic-cli",
      "apiKey",
    ]);
  });

  it("groups OpenCode Zen and Go under one OpenCode entry", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "opencode-zen",
        choiceLabel: "OpenCode Zen catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
        methodId: "api-key",
        pluginId: "opencode",
        providerId: "opencode",
      },
      {
        choiceId: "opencode-go",
        choiceLabel: "OpenCode Go catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
        methodId: "api-key",
        pluginId: "opencode-go",
        providerId: "opencode-go",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      store: EMPTY_STORE,
    });
    const openCodeGroup = groups.find((group) => group.value === "opencode");

    expect(openCodeGroup).toBeDefined();
    expect(openCodeGroup?.options.some((opt) => opt.value === "opencode-zen")).toBe(true);
    expect(openCodeGroup?.options.some((opt) => opt.value === "opencode-go")).toBe(true);
  });

  it("shows Ollama in grouped provider selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        groupId: "ollama",
        groupLabel: "Ollama",
        hint: "Cloud and local open models",
        label: "Ollama",
        value: "ollama",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      includeSkip: false,
      store: EMPTY_STORE,
    });
    const ollamaGroup = groups.find((group) => group.value === "ollama");

    expect(ollamaGroup).toBeDefined();
    expect(ollamaGroup?.options.some((opt) => opt.value === "ollama")).toBe(true);
  });

  it("hides image-generation-only providers from the interactive auth picker", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        choiceId: "fal-api-key",
        choiceLabel: "fal API key",
        groupId: "fal",
        groupLabel: "fal",
        methodId: "api-key",
        onboardingScopes: ["image-generation"],
        pluginId: "fal",
        providerId: "fal",
      },
      {
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        methodId: "api-key",
        pluginId: "openai",
        providerId: "openai",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        groupId: "local-image-runtime",
        groupLabel: "Local image runtime",
        label: "Local image runtime",
        onboardingScopes: ["image-generation"],
        value: "local-image-runtime",
      },
      {
        groupId: "ollama",
        groupLabel: "Ollama",
        label: "Ollama",
        value: "ollama",
      },
    ]);

    const options = getOptions();

    expect(options.some((option) => option.value === "openai-api-key")).toBe(true);
    expect(options.some((option) => option.value === "ollama")).toBe(true);
    expect(options.some((option) => option.value === "fal-api-key")).toBe(false);
    expect(options.some((option) => option.value === "local-image-runtime")).toBe(false);
  });
});
