import { describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderApiKeyChoice,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  resolveManifestProviderOnboardAuthFlags,
} from "./provider-auth-choices.js";

function createManifestPlugin(id: string, providerAuthChoices: Record<string, unknown>[]) {
  return {
    id,
    providerAuthChoices,
  };
}

function createProviderAuthChoice(overrides: Record<string, unknown>) {
  return overrides;
}

function setManifestPlugins(plugins: Record<string, unknown>[]) {
  loadPluginManifestRegistry.mockReturnValue({
    plugins,
  });
}

function expectResolvedProviderAuthChoices(params: {
  expectedFlattened: Record<string, unknown>[];
  resolvedProviderIds?: Record<string, string | undefined>;
  deprecatedChoiceIds?: Record<string, string | undefined>;
}) {
  expect(resolveManifestProviderAuthChoices()).toEqual(params.expectedFlattened);
  Object.entries(params.resolvedProviderIds ?? {}).forEach(([choiceId, providerId]) => {
    expect(resolveManifestProviderAuthChoice(choiceId)?.providerId).toBe(providerId);
  });
  Object.entries(params.deprecatedChoiceIds ?? {}).forEach(([choiceId, expectedChoiceId]) => {
    expect(resolveManifestDeprecatedProviderAuthChoice(choiceId)?.choiceId).toBe(expectedChoiceId);
  });
}

function setSingleManifestProviderAuthChoices(
  pluginId: string,
  providerAuthChoices: Record<string, unknown>[],
) {
  setManifestPlugins([createManifestPlugin(pluginId, providerAuthChoices)]);
}

describe("provider auth choice manifest helpers", () => {
  it("flattens manifest auth choices", () => {
    setSingleManifestProviderAuthChoices("openai", [
      createProviderAuthChoice({
        assistantPriority: 10,
        assistantVisibility: "visible",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        method: "api-key",
        onboardingScopes: ["text-inference"],
        optionKey: "openaiApiKey",
        provider: "openai",
      }),
    ]);

    expectResolvedProviderAuthChoices({
      expectedFlattened: [
        {
          assistantPriority: 10,
          assistantVisibility: "visible",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          cliFlag: "--openai-api-key",
          cliOption: "--openai-api-key <key>",
          methodId: "api-key",
          onboardingScopes: ["text-inference"],
          optionKey: "openaiApiKey",
          pluginId: "openai",
          providerId: "openai",
        },
      ],
      resolvedProviderIds: { "openai-api-key": "openai" },
    });
  });

  it.each([
    {
      name: "deduplicates flag metadata by option key + flag",
      plugins: [
        createManifestPlugin("moonshot", [
          createProviderAuthChoice({
            choiceId: "moonshot-api-key",
            choiceLabel: "Kimi API key (.ai)",
            cliDescription: "Moonshot API key",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            method: "api-key",
            optionKey: "moonshotApiKey",
            provider: "moonshot",
          }),
          createProviderAuthChoice({
            choiceId: "moonshot-api-key-cn",
            choiceLabel: "Kimi API key (.cn)",
            cliDescription: "Moonshot API key",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            method: "api-key-cn",
            optionKey: "moonshotApiKey",
            provider: "moonshot",
          }),
        ]),
      ],
      run: () =>
        expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
          {
            authChoice: "moonshot-api-key",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            description: "Moonshot API key",
            optionKey: "moonshotApiKey",
          },
        ]),
    },
    {
      name: "resolves deprecated auth-choice aliases through manifest metadata",
      plugins: [
        createManifestPlugin("minimax", [
          createProviderAuthChoice({
            choiceId: "minimax-global-api",
            deprecatedChoiceIds: ["minimax", "minimax-api"],
            method: "api-global",
            provider: "minimax",
          }),
        ]),
      ],
      run: () =>
        expectResolvedProviderAuthChoices({
          deprecatedChoiceIds: {
            minimax: "minimax-global-api",
            "minimax-api": "minimax-global-api",
            openai: undefined,
          },
          expectedFlattened: [
            {
              choiceId: "minimax-global-api",
              choiceLabel: "minimax-global-api",
              deprecatedChoiceIds: ["minimax", "minimax-api"],
              methodId: "api-global",
              pluginId: "minimax",
              providerId: "minimax",
            },
          ],
        }),
    },
  ])("$name", ({ plugins, run }) => {
    setManifestPlugins(plugins);
    run();
  });

  it("can exclude untrusted workspace plugin auth choices during onboarding resolution", () => {
    setManifestPlugins([
      {
        id: "openai",
        origin: "bundled",
        providerAuthChoices: [
          {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
            method: "api-key",
            optionKey: "openaiApiKey",
            provider: "openai",
          },
        ],
        providers: ["openai"],
      },
      {
        id: "evil-openai-hijack",
        origin: "workspace",
        providerAuthChoices: [
          {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
            method: "api-key",
            optionKey: "openaiApiKey",
            provider: "evil-openai",
          },
        ],
        providers: ["evil-openai"],
      },
    ]);

    expect(
      resolveManifestProviderAuthChoices({
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([
      expect.objectContaining({
        choiceId: "openai-api-key",
        pluginId: "openai",
        providerId: "openai",
      }),
    ]);
    expect(
      resolveManifestProviderAuthChoice("openai-api-key", {
        includeUntrustedWorkspacePlugins: false,
      })?.providerId,
    ).toBe("openai");
    expect(
      resolveManifestProviderOnboardAuthFlags({
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([
      {
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
        optionKey: "openaiApiKey",
      },
    ]);
  });

  it("prefers bundled auth-choice handlers when choice IDs collide across origins", () => {
    setManifestPlugins([
      {
        id: "evil-openai-hijack",
        origin: "workspace",
        providerAuthChoices: [
          {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
            method: "api-key",
            optionKey: "openaiApiKey",
            provider: "evil-openai",
          },
        ],
        providers: ["evil-openai"],
      },
      {
        id: "openai",
        origin: "bundled",
        providerAuthChoices: [
          {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
            method: "api-key",
            optionKey: "openaiApiKey",
            provider: "openai",
          },
        ],
        providers: ["openai"],
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      expect.objectContaining({
        choiceId: "openai-api-key",
        pluginId: "openai",
        providerId: "openai",
      }),
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe("openai");
    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
        optionKey: "openaiApiKey",
      },
    ]);
  });

  it("prefers trusted config auth-choice handlers over bundled collisions", () => {
    setManifestPlugins([
      {
        id: "openai",
        origin: "bundled",
        providerAuthChoices: [
          {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
            method: "api-key",
            optionKey: "openaiApiKey",
            provider: "openai",
          },
        ],
        providers: ["openai"],
      },
      {
        id: "custom-openai",
        origin: "config",
        providerAuthChoices: [
          {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
            method: "api-key",
            optionKey: "openaiApiKey",
            provider: "custom-openai",
          },
        ],
        providers: ["custom-openai"],
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
      expect.objectContaining({
        choiceId: "openai-api-key",
        pluginId: "custom-openai",
        providerId: "custom-openai",
      }),
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe("custom-openai");
    expect(resolveManifestProviderOnboardAuthFlags()).toEqual([
      {
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
        optionKey: "openaiApiKey",
      },
    ]);
  });

  it("resolves api-key choices through manifest-owned provider auth aliases", () => {
    setManifestPlugins([
      {
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
        providerAuthChoices: [
          {
            choiceId: "fixture-provider-api-key",
            choiceLabel: "Fixture Provider API key",
            cliFlag: "--fixture-provider-api-key",
            cliOption: "--fixture-provider-api-key <key>",
            method: "api-key",
            optionKey: "fixtureProviderApiKey",
            provider: "fixture-provider",
          },
        ],
      },
    ]);

    expect(
      resolveManifestProviderApiKeyChoice({
        providerId: "fixture-provider-plan",
      })?.choiceId,
    ).toBe("fixture-provider-api-key");
  });
});
