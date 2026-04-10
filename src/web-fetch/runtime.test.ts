import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import {
  type WebFetchTestProviderParams,
  createWebFetchTestProvider,
} from "../test-utils/web-provider-runtime.test-helpers.js";

interface TestPluginWebFetchConfig {
  webFetch?: {
    apiKey?: unknown;
  };
}

const { resolvePluginWebFetchProvidersMock, resolveRuntimeWebFetchProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
    resolveRuntimeWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  }),
);

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProviders: resolveRuntimeWebFetchProvidersMock,
}));

function getFirecrawlApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
    | TestPluginWebFetchConfig
    | undefined;
  return pluginConfig?.webFetch?.apiKey;
}

function createFirecrawlProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    autoDetectOrder: 1,
    credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
    id: "firecrawl",
    pluginId: "firecrawl",
    ...overrides,
  });
}

function createThirdPartyFetchProvider(): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    autoDetectOrder: 0,
    credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
    getConfiguredCredentialValue: () => "runtime-key",
    id: "thirdparty",
    pluginId: "third-party-fetch",
  });
}

function createFirecrawlPluginConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: {
          config: {
            webFetch: {
              apiKey,
            },
          },
          enabled: true,
        },
      },
    },
  };
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({ resolveWebFetchDefinition } = await import("./runtime.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    resolvePluginWebFetchProvidersMock.mockReset();
    resolveRuntimeWebFetchProvidersMock.mockReset();
    resolvePluginWebFetchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("does not auto-detect providers from plugin-owned env SecretRefs without runtime metadata", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config = createFirecrawlPluginConfig({
      id: "AWS_SECRET_ACCESS_KEY",
      provider: "default",
      source: "env",
    });

    vi.stubEnv("FIRECRAWL_API_KEY", "");

    expect(resolveWebFetchDefinition({ config })).toBeNull();
  });

  it("prefers the runtime-selected provider when metadata is available", async () => {
    const provider = createFirecrawlProvider({
      createTool: ({ runtimeMetadata }) => ({
        description: "firecrawl",
        execute: async (args) => ({
          ...args,
          provider: runtimeMetadata?.selectedProvider ?? "firecrawl",
        }),
        parameters: {},
      }),
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([provider]);

    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      diagnostics: [],
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
    };

    const resolved = resolveWebFetchDefinition({
      config: {},
      preferRuntimeProviders: true,
      runtimeWebFetch,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
    await expect(
      resolved?.definition.execute({
        extractMode: "markdown",
        maxChars: 1000,
        url: "https://example.com",
      }),
    ).resolves.toEqual({
      extractMode: "markdown",
      maxChars: 1000,
      provider: "firecrawl",
      url: "https://example.com",
    });
  });

  it("auto-detects providers from provider-declared env vars", () => {
    const provider = createFirecrawlProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-env-key");

    const resolved = resolveWebFetchDefinition({
      config: {},
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "does-not-exist",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("keeps sandboxed web fetch on bundled providers even when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      preferRuntimeProviders: true,
      sandboxed: true,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("keeps non-sandboxed web fetch on bundled providers even when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      preferRuntimeProviders: true,
      sandboxed: false,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });
});
