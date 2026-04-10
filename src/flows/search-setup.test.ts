import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { runSearchSetupFlow } from "./search-setup.js";

const mockGrokProvider = vi.hoisted(() => ({
  credentialLabel: "xAI API key",
  credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
  docsUrl: "https://docs.openclaw.ai/tools/web",
  envVars: ["XAI_API_KEY"],
  getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | {
            entries?: Record<
              string,
              {
                config?: {
                  webSearch?: { apiKey?: unknown };
                };
              }
            >;
          }
        | undefined
    )?.entries?.xai?.config?.webSearch?.apiKey,
  getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
  hint: "Search with xAI",
  id: "grok",
  label: "Grok",
  onboardingScopes: ["text-inference"],
  placeholder: "xai-...",
  pluginId: "xai",
  requiresCredential: true,
  runSetup: async ({
    config,
    prompter,
  }: {
    config: Record<string, unknown>;
    prompter: { select: (params: Record<string, unknown>) => Promise<string> };
  }) => {
    const enableXSearch = await prompter.select({
      message: "Enable x_search",
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    });
    if (enableXSearch !== "yes") {
      return config;
    }
    const model = await prompter.select({
      message: "Grok model",
      options: [{ label: "grok-4-1-fast", value: "grok-4-1-fast" }],
    });
    const pluginEntries = (config.plugins as { entries?: Record<string, unknown> } | undefined)
      ?.entries;
    const existingXaiEntry = pluginEntries?.xai as Record<string, unknown> | undefined;
    const existingXaiConfig = (
      pluginEntries?.xai as { config?: Record<string, unknown> } | undefined
    )?.config;
    return {
      ...config,
      plugins: {
        ...(config.plugins as Record<string, unknown> | undefined),
        entries: {
          ...pluginEntries,
          xai: {
            ...existingXaiEntry,
            config: {
              ...existingXaiConfig,
              xSearch: {
                enabled: true,
                model,
              },
            },
          },
        },
      },
    };
  },
  setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
    const plugins = (configTarget.plugins ??= {}) as Record<string, unknown>;
    const entries = (plugins.entries ??= {}) as Record<string, unknown>;
    const xaiEntry = (entries.xai ??= {}) as Record<string, unknown>;
    const xaiConfig = (xaiEntry.config ??= {}) as Record<string, unknown>;
    const webSearch = (xaiConfig.webSearch ??= {}) as Record<string, unknown>;
    webSearch.apiKey = value;
  },
  setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => {
    searchConfigTarget.apiKey = value;
  },
  signupUrl: "https://x.ai/api",
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: () => [mockGrokProvider],
}));

describe("runSearchSetupFlow", () => {
  it("runs provider-owned setup after selecting Grok web search", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const text = vi.fn().mockResolvedValue("xai-test-key");
    const prompter = createWizardPrompter({
      select: select as never,
      text: text as never,
    });

    const next = await runSearchSetupFlow(
      { plugins: { allow: ["xai"] } },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.plugins?.entries?.xai?.config?.webSearch).toMatchObject({
      apiKey: "xai-test-key",
    });
    expect(next.tools?.web?.search).toMatchObject({
      enabled: true,
      provider: "grok",
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });

  it("preserves disabled web_search state while still allowing provider-owned x_search setup", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("grok")
      .mockResolvedValueOnce("yes")
      .mockResolvedValueOnce("grok-4-1-fast");
    const prompter = createWizardPrompter({
      select: select as never,
    });

    const next = await runSearchSetupFlow(
      {
        plugins: {
          allow: ["xai"],
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-test-key",
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "grok",
            },
          },
        },
      },
      createNonExitingRuntime(),
      prompter,
    );

    expect(next.tools?.web?.search).toMatchObject({
      enabled: false,
      provider: "grok",
    });
    expect(next.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4-1-fast",
    });
  });
});
