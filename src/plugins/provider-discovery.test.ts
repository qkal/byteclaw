import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderCatalog,
} from "./provider-discovery.js";
import type { ProviderCatalogResult, ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderDiscoveryOrder;
  mode?: "catalog" | "discovery";
  aliases?: string[];
  hookAliases?: string[];
}): ProviderPlugin {
  const hook = {
    ...(params.order ? { order: params.order } : {}),
    run: async () => null,
  };
  return {
    auth: [],
    id: params.id,
    label: params.label ?? params.id,
    ...(params.aliases ? { aliases: params.aliases } : {}),
    ...(params.hookAliases ? { hookAliases: params.hookAliases } : {}),
    ...(params.mode === "discovery" ? { discovery: hook } : { catalog: hook }),
  };
}

function makeModelProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
    ...overrides,
  };
}

function expectGroupedProviderIds(
  providers: readonly ProviderPlugin[],
  expected: Record<ProviderDiscoveryOrder | "late", readonly string[]>,
) {
  const grouped = groupPluginDiscoveryProvidersByOrder([...providers]);
  const actual = {
    late: grouped.late.map((provider) => provider.id),
    paired: grouped.paired.map((provider) => provider.id),
    profile: grouped.profile.map((provider) => provider.id),
    simple: grouped.simple.map((provider) => provider.id),
  };
  expect(actual).toEqual(expected);
}

function createCatalogRuntimeContext() {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

function createCatalogProvider(params: {
  id?: string;
  catalogRun?: () => Promise<ProviderCatalogResult>;
  discoveryRun?: () => Promise<ProviderCatalogResult>;
}) {
  return {
    auth: [],
    id: params.id ?? "demo",
    label: "Demo",
    ...(params.catalogRun ? { catalog: { run: params.catalogRun } } : {}),
    ...(params.discoveryRun ? { discovery: { run: params.discoveryRun } } : {}),
  };
}

function expectNormalizedDiscoveryResult(params: {
  provider: ProviderPlugin;
  result: Parameters<typeof normalizePluginDiscoveryResult>[0]["result"];
  expected: Record<string, unknown>;
}) {
  expect(
    normalizePluginDiscoveryResult({
      provider: params.provider,
      result: params.result,
    }),
  ).toEqual(params.expected);
}

async function expectProviderCatalogResult(params: {
  provider: ProviderPlugin;
  expected: Record<string, unknown>;
}) {
  await expect(
    runProviderCatalog({
      provider: params.provider,
      ...createCatalogRuntimeContext(),
    }),
  ).resolves.toEqual(params.expected);
}

describe("groupPluginDiscoveryProvidersByOrder", () => {
  it.each([
    {
      expected: {
        late: ["late-a", "late-b"],
        paired: ["paired"],
        profile: ["profile"],
        simple: ["simple"],
      },
      name: "groups providers by declared order and sorts labels within each group",
      providers: [
        makeProvider({ id: "late-b", label: "Zulu" }),
        makeProvider({ id: "late-a", label: "Alpha" }),
        makeProvider({ id: "paired", label: "Paired", order: "paired" }),
        makeProvider({ id: "profile", label: "Profile", order: "profile" }),
        makeProvider({ id: "simple", label: "Simple", order: "simple" }),
      ],
    },
    {
      expected: {
        late: [],
        paired: [],
        profile: ["legacy"],
        simple: [],
      },
      name: "uses the legacy discovery hook when catalog is absent",
      providers: [
        makeProvider({ id: "legacy", label: "Legacy", mode: "discovery", order: "profile" }),
      ],
    },
  ] as const)("$name", ({ providers, expected }) => {
    expectGroupedProviderIds(providers, expected);
  });
});

describe("normalizePluginDiscoveryResult", () => {
  it.each([
    {
      expected: {
        ollama: {
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          models: [],
        },
      },
      name: "maps a single provider result to the plugin id",
      provider: makeProvider({ id: "Ollama" }),
      result: {
        provider: makeModelProviderConfig({
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
        }),
      },
    },
    {
      expected: {
        anthropic: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          models: [],
        },
        "anthropic-api": {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          models: [],
        },
        "claude-cli": {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          models: [],
        },
      },
      name: "maps a single provider result to aliases and hook aliases",
      provider: makeProvider({
        aliases: ["anthropic-api"],
        hookAliases: ["claude-cli"],
        id: "Anthropic",
      }),
      result: {
        provider: makeModelProviderConfig({
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
        }),
      },
    },
    {
      expected: {
        vllm: {
          baseUrl: "http://127.0.0.1:8000/v1",
          models: [],
        },
      },
      name: "normalizes keys for multi-provider discovery results",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          "": makeModelProviderConfig({ baseUrl: "http://ignored" }),
          " VLLM ": makeModelProviderConfig(),
        },
      },
    },
  ] as const)("$name", ({ provider, result, expected }) => {
    expectNormalizedDiscoveryResult({ expected, provider, result });
  });
});

describe("runProviderCatalog", () => {
  it("prefers catalog over discovery when both exist", async () => {
    const catalogRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://catalog.example/v1" }),
    });
    const discoveryRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://discovery.example/v1" }),
    });

    await expectProviderCatalogResult({
      expected: {
        provider: {
          baseUrl: "http://catalog.example/v1",
          models: [],
        },
      },
      provider: createCatalogProvider({
        catalogRun,
        discoveryRun,
      }),
    });
  });
});
