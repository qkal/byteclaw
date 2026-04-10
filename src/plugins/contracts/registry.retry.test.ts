import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, WebFetchProviderPlugin, WebSearchProviderPlugin } from "../types.js";

interface MockPluginRecord {
  id: string;
  status: "loaded" | "error";
  error?: string;
  providerIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
}

interface MockRuntimeRegistry {
  plugins: MockPluginRecord[];
  diagnostics: { pluginId?: string; message: string }[];
  providers: { pluginId: string; provider: ProviderPlugin }[];
  webFetchProviders: { pluginId: string; provider: WebFetchProviderPlugin }[];
  webSearchProviders: { pluginId: string; provider: WebSearchProviderPlugin }[];
}

function createMockRuntimeRegistry(params: {
  plugin: MockPluginRecord;
  providers?: { pluginId: string; provider: ProviderPlugin }[];
  webFetchProviders?: { pluginId: string; provider: WebFetchProviderPlugin }[];
  webSearchProviders?: { pluginId: string; provider: WebSearchProviderPlugin }[];
  diagnostics?: { pluginId?: string; message: string }[];
}): MockRuntimeRegistry {
  return {
    diagnostics: params.diagnostics ?? [],
    plugins: [params.plugin],
    providers: params.providers ?? [],
    webFetchProviders: params.webFetchProviders ?? [],
    webSearchProviders: params.webSearchProviders ?? [],
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("plugin contract registry scoped retries", () => {
  it("retries provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          diagnostics: [{ message: "transient xai load failure", pluginId: "xai" }],
          plugin: {
            error: "transient xai load failure",
            id: "xai",
            providerIds: [],
            status: "error",
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            providerIds: ["xai"],
            status: "loaded",
            webFetchProviderIds: [],
            webSearchProviderIds: ["grok"],
          },
          providers: [
            {
              pluginId: "xai",
              provider: {
                auth: [],
                docsPath: "/providers/xai",
                id: "xai",
                label: "xAI",
              } as ProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveProviderContractProvidersForPluginIds } = await import("./registry.js");

    expect(
      resolveProviderContractProvidersForPluginIds(["xai"]).map((provider) => provider.id),
    ).toEqual(["xai"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("retries web search provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          diagnostics: [{ message: "transient grok load failure", pluginId: "xai" }],
          plugin: {
            error: "transient grok load failure",
            id: "xai",
            providerIds: [],
            status: "error",
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            providerIds: ["xai"],
            status: "loaded",
            webFetchProviderIds: [],
            webSearchProviderIds: ["grok"],
          },
          webSearchProviders: [
            {
              pluginId: "xai",
              provider: {
                createTool: () => ({
                  description: "search",
                  execute: async () => ({}),
                  parameters: {},
                }),
                credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
                envVars: ["XAI_API_KEY"],
                getCredentialValue: () => undefined,
                hint: "Search the web with Grok",
                id: "grok",
                label: "Grok Search",
                placeholder: "XAI_API_KEY",
                requiresCredential: true,
                setCredentialValue() {},
                signupUrl: "https://x.ai",
              } as WebSearchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebSearchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebSearchProviderContractEntriesForPluginId("xai").map((entry) => entry.provider.id),
    ).toEqual(["grok"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("reuses the single registered provider contract for paired manifest alias ids", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn().mockReturnValue(
      createMockRuntimeRegistry({
        plugin: {
          id: "byteplus",
          providerIds: ["byteplus"],
          status: "loaded",
          webFetchProviderIds: [],
          webSearchProviderIds: [],
        },
        providers: [
          {
            pluginId: "byteplus",
            provider: {
              auth: [],
              docsPath: "/providers/byteplus",
              id: "byteplus",
              label: "BytePlus",
            } as ProviderPlugin,
          },
        ],
      }),
    );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { requireProviderContractProvider } = await import("./registry.js");

    expect(requireProviderContractProvider("byteplus-plan").id).toBe("byteplus");
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);
  });

  it("retries web fetch provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          diagnostics: [
            { message: "transient firecrawl fetch load failure", pluginId: "firecrawl" },
          ],
          plugin: {
            error: "transient firecrawl fetch load failure",
            id: "firecrawl",
            providerIds: [],
            status: "error",
            webFetchProviderIds: [],
            webSearchProviderIds: [],
          },
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "firecrawl",
            providerIds: [],
            status: "loaded",
            webFetchProviderIds: ["firecrawl"],
            webSearchProviderIds: ["firecrawl"],
          },
          webFetchProviders: [
            {
              pluginId: "firecrawl",
              provider: {
                createTool: () => ({
                  description: "fetch",
                  execute: async () => ({}),
                  parameters: {},
                }),
                credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
                envVars: ["FIRECRAWL_API_KEY"],
                getCredentialValue: () => undefined,
                hint: "Fetch with Firecrawl",
                id: "firecrawl",
                label: "Firecrawl",
                placeholder: "fc-...",
                requiresCredential: true,
                setCredentialValue() {},
                signupUrl: "https://firecrawl.dev",
              } as WebFetchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebFetchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebFetchProviderContractEntriesForPluginId("firecrawl").map(
        (entry) => entry.provider.id,
      ),
    ).toEqual(["firecrawl"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });
});
