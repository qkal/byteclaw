import { expect } from "vitest";

export const openaiCodexCatalogEntries = [
  { id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
  { id: "gpt-5.2-pro", name: "GPT-5.2 Pro", provider: "openai" },
  { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai" },
  { id: "gpt-5-nano", name: "GPT-5 nano", provider: "openai" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai-codex" },
];

export const expectedAugmentedOpenaiCodexCatalogEntries = [
  { id: "gpt-5.4", name: "gpt-5.4", provider: "openai" },
  { id: "gpt-5.4-pro", name: "gpt-5.4-pro", provider: "openai" },
  { id: "gpt-5.4-mini", name: "gpt-5.4-mini", provider: "openai" },
  { id: "gpt-5.4-nano", name: "gpt-5.4-nano", provider: "openai" },
  { id: "gpt-5.4", name: "gpt-5.4", provider: "openai-codex" },
  { id: "gpt-5.4-mini", name: "gpt-5.4-mini", provider: "openai-codex" },
  {
    id: "gpt-5.3-codex-spark",
    name: "gpt-5.3-codex-spark",
    provider: "openai-codex",
  },
];

export function expectCodexMissingAuthHint(
  buildProviderMissingAuthMessageWithPlugin: (params: {
    provider: string;
    env: NodeJS.ProcessEnv;
    context: {
      env: NodeJS.ProcessEnv;
      provider: string;
      listProfileIds: (providerId: string) => string[];
    };
  }) => string | undefined,
) {
  expect(
    buildProviderMissingAuthMessageWithPlugin({
      context: {
        env: process.env,
        listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
        provider: "openai",
      },
      env: process.env,
      provider: "openai",
    }),
  ).toContain("openai-codex/gpt-5.4");
}

export function expectCodexBuiltInSuppression(
  resolveProviderBuiltInModelSuppression: (params: {
    env: NodeJS.ProcessEnv;
    context: {
      env: NodeJS.ProcessEnv;
      provider: string;
      modelId: string;
    };
  }) => unknown,
) {
  expect(
    resolveProviderBuiltInModelSuppression({
      context: {
        env: process.env,
        modelId: "gpt-5.3-codex-spark",
        provider: "azure-openai-responses",
      },
      env: process.env,
    }),
  ).toMatchObject({
    errorMessage: expect.stringContaining("openai-codex/gpt-5.3-codex-spark"),
    suppress: true,
  });
}

export async function expectAugmentedCodexCatalog(
  augmentModelCatalogWithProviderPlugins: (params: {
    env: NodeJS.ProcessEnv;
    context: {
      env: NodeJS.ProcessEnv;
      entries: typeof openaiCodexCatalogEntries;
    };
  }) => Promise<unknown>,
) {
  const result = (await augmentModelCatalogWithProviderPlugins({
    context: {
      entries: openaiCodexCatalogEntries,
      env: process.env,
    },
    env: process.env,
  })) as Record<string, unknown>[];
  expect(result).toHaveLength(expectedAugmentedOpenaiCodexCatalogEntries.length);
  for (const entry of expectedAugmentedOpenaiCodexCatalogEntries) {
    expect(result).toContainEqual(expect.objectContaining(entry));
  }
}
