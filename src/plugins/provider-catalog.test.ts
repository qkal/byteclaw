import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";
import type { ProviderCatalogContext } from "./types.js";

function createProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://default.example/v1",
    models: [],
    ...overrides,
  };
}

function createCatalogContext(params: {
  config?: OpenClawConfig;
  apiKeys?: Record<string, string | undefined>;
}): ProviderCatalogContext {
  return {
    config: params.config ?? {},
    env: {},
    resolveProviderApiKey: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
    }),
    resolveProviderAuth: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
      mode: providerId && params.apiKeys?.[providerId] ? "api_key" : "none",
      source: providerId && params.apiKeys?.[providerId] ? "env" : "none",
    }),
  };
}

function expectCatalogTemplateMatch(params: {
  entries: Parameters<typeof findCatalogTemplate>[0]["entries"];
  providerId: string;
  templateIds: readonly string[];
  expected: ReturnType<typeof findCatalogTemplate>;
}) {
  expect(
    findCatalogTemplate({
      entries: params.entries,
      providerId: params.providerId,
      templateIds: params.templateIds,
    }),
  ).toEqual(params.expected);
}

function expectPairedCatalogProviders(
  result: Awaited<ReturnType<typeof buildPairedProviderApiKeyCatalog>>,
  expected: Record<string, ModelProviderConfig & { apiKey: string }>,
) {
  expect(result).toEqual({
    providers: expected,
  });
}

function createSingleCatalogProvider(overrides: Partial<ModelProviderConfig> & { apiKey: string }) {
  return {
    provider: {
      ...createProviderConfig(overrides),
      apiKey: overrides.apiKey,
    },
  };
}

function createPairedCatalogProviders(
  apiKey: string,
  overrides: Partial<ModelProviderConfig> = {},
) {
  return {
    alpha: {
      ...createProviderConfig(overrides),
      apiKey,
    },
    beta: {
      ...createProviderConfig(overrides),
      apiKey,
    },
  };
}

async function expectSingleCatalogResult(params: {
  ctx: ProviderCatalogContext;
  providerId?: string;
  allowExplicitBaseUrl?: boolean;
  buildProvider?: () => ModelProviderConfig;
  expected: Awaited<ReturnType<typeof buildSingleProviderApiKeyCatalog>>;
}) {
  const result = await buildSingleProviderApiKeyCatalog({
    allowExplicitBaseUrl: params.allowExplicitBaseUrl,
    buildProvider: params.buildProvider ?? (() => createProviderConfig()),
    ctx: params.ctx,
    providerId: params.providerId ?? "test-provider",
  });

  expect(result).toEqual(params.expected);
}

async function expectPairedCatalogResult(params: {
  ctx: ProviderCatalogContext;
  expected: Record<string, ModelProviderConfig & { apiKey: string }>;
}) {
  const result = await buildPairedProviderApiKeyCatalog({
    buildProviders: async () => ({
      alpha: createProviderConfig(),
      beta: createProviderConfig(),
    }),
    ctx: params.ctx,
    providerId: "test-provider",
  });

  expectPairedCatalogProviders(result, params.expected);
}

describe("buildSingleProviderApiKeyCatalog", () => {
  it.each([
    {
      entries: [
        { id: "demo-model", provider: "Demo Provider" },
        { id: "fallback", provider: "other" },
      ],
      expected: { id: "demo-model", provider: "Demo Provider" },
      name: "matches provider templates case-insensitively",
      providerId: "demo provider",
      templateIds: ["missing", "DEMO-MODEL"],
    },
    {
      entries: [
        { id: "glm-4.7", provider: "z.ai" },
        { id: "fallback", provider: "other" },
      ],
      expected: { id: "glm-4.7", provider: "z.ai" },
      name: "matches provider templates across canonical provider aliases",
      providerId: "z-ai",
      templateIds: ["GLM-4.7"],
    },
  ] as const)("$name", ({ entries, providerId, templateIds, expected }) => {
    expectCatalogTemplateMatch({
      entries,
      expected,
      providerId,
      templateIds,
    });
  });
  it.each([
    {
      ctx: createCatalogContext({}),
      expected: null,
      name: "returns null when api key is missing",
    },
    {
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      expected: createSingleCatalogProvider({
        apiKey: "secret-key",
      }),
      name: "adds api key to the built provider",
    },
    {
      allowExplicitBaseUrl: true,
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
        config: {
          models: {
            providers: {
              "test-provider": {
                baseUrl: " https://override.example/v1/ ",
                models: [],
              },
            },
          },
        },
      }),
      expected: createSingleCatalogProvider({
        apiKey: "secret-key",
        baseUrl: "https://override.example/v1/",
      }),
      name: "prefers explicit base url when allowed",
    },
    {
      allowExplicitBaseUrl: true,
      buildProvider: () => createProviderConfig({ baseUrl: "https://default.example/zai" }),
      ctx: createCatalogContext({
        apiKeys: { zai: "secret-key" },
        config: {
          models: {
            providers: {
              "z.ai": {
                baseUrl: " https://api.z.ai/custom ",
                models: [],
              },
            },
          },
        },
      }),
      expected: createSingleCatalogProvider({
        apiKey: "secret-key",
        baseUrl: "https://api.z.ai/custom",
      }),
      name: "matches explicit base url config across canonical provider aliases",
      providerId: "z-ai",
    },
  ] as const)(
    "$name",
    async ({ ctx, allowExplicitBaseUrl, expected, providerId, buildProvider }) => {
      await expectSingleCatalogResult({
        ctx,
        ...(providerId ? { providerId } : {}),
        allowExplicitBaseUrl,
        ...(buildProvider ? { buildProvider } : {}),
        expected,
      });
    },
  );

  it("adds api key to each paired provider", async () => {
    await expectPairedCatalogResult({
      ctx: createCatalogContext({
        apiKeys: { "test-provider": "secret-key" },
      }),
      expected: createPairedCatalogProviders("secret-key"),
    });
  });
});
