import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolvePluginWebSearchProviders: vi.fn<
    (params?: { config?: OpenClawConfig }) => PluginWebSearchProviderEntry[]
  >(() => []),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: mocks.resolvePluginWebSearchProviders,
}));

function createCustomProviderEntry(): PluginWebSearchProviderEntry {
  return {
    createTool: () => null,
    credentialPath: "plugins.entries.custom-plugin.config.webSearch.apiKey",
    envVars: ["CUSTOM_SEARCH_API_KEY"],
    getConfiguredCredentialValue: (config) =>
      (
        config?.plugins?.entries?.["custom-plugin"]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    getCredentialValue: () => undefined,
    hint: "Custom provider",
    id: "custom-search" as never,
    label: "Custom Search",
    onboardingScopes: ["text-inference"],
    placeholder: "custom-...",
    pluginId: "custom-plugin",
    setConfiguredCredentialValue: (configTarget, value) => {
      const entries = ((configTarget.plugins ??= {}).entries ??= {});
      const pluginEntry = (entries["custom-plugin"] ??= {});
      const pluginConfig = ((pluginEntry as Record<string, unknown>).config ??= {}) as Record<
        string,
        unknown
      >;
      const webSearch = (pluginConfig.webSearch ??= {}) as Record<string, unknown>;
      webSearch.apiKey = value;
    },
    setCredentialValue: () => {},
    signupUrl: "https://example.com/custom",
  };
}

function createBundledFirecrawlEntry(): PluginWebSearchProviderEntry {
  return {
    createTool: () => null,
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    envVars: ["FIRECRAWL_API_KEY"],
    getConfiguredCredentialValue: (config) =>
      (
        config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    getCredentialValue: () => undefined,
    hint: "Structured results",
    id: "firecrawl",
    label: "Firecrawl Search",
    onboardingScopes: ["text-inference"],
    placeholder: "fc-...",
    pluginId: "firecrawl",
    setConfiguredCredentialValue: () => {},
    setCredentialValue: () => {},
    signupUrl: "https://example.com/firecrawl",
  };
}

function createBundledDuckDuckGoEntry(): PluginWebSearchProviderEntry {
  return {
    createTool: () => null,
    credentialPath: "",
    envVars: [],
    getCredentialValue: () => "duckduckgo-no-key-needed",
    hint: "Free fallback",
    id: "duckduckgo",
    label: "DuckDuckGo Search (experimental)",
    onboardingScopes: ["text-inference"],
    placeholder: "(no key needed)",
    pluginId: "duckduckgo",
    requiresCredential: false,
    setCredentialValue: () => {},
    signupUrl: "https://duckduckgo.com/",
  };
}

describe("onboard-search provider resolution", () => {
  let mod: typeof import("./onboard-search.js");

  beforeAll(async () => {
    mod = await import("./onboard-search.js");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses config-aware non-bundled provider hooks when resolving existing keys", async () => {
    const customEntry = createCustomProviderEntry();
    mocks.resolvePluginWebSearchProviders.mockImplementation((params) =>
      params?.config ? [customEntry] : [],
    );

    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          "custom-plugin": {
            config: {
              webSearch: {
                apiKey: "custom-key",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            provider: "custom-search" as never,
          },
        },
      },
    };

    expect(mod.hasExistingKey(cfg, "custom-search" as never)).toBe(true);
    expect(mod.resolveExistingKey(cfg, "custom-search" as never)).toBe("custom-key");

    const updated = mod.applySearchKey(cfg, "custom-search" as never, "next-key");
    expect(
      (
        updated.plugins?.entries?.["custom-plugin"]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    ).toBe("next-key");
  });

  it("uses config-aware non-bundled providers when building secret refs", async () => {
    const customEntry = createCustomProviderEntry();
    mocks.resolvePluginWebSearchProviders.mockImplementation((params) =>
      params?.config ? [customEntry] : [],
    );

    const cfg: OpenClawConfig = {
      plugins: {
        installs: {
          "custom-plugin": {
            installPath: "/tmp/custom-plugin",
            source: "path",
          },
        },
      },
    };
    const notes: { title?: string; message: string }[] = [];
    const prompter = {
      confirm: vi.fn(async () => true),
      intro: vi.fn(async () => {}),
      multiselect: vi.fn(async () => []),
      note: vi.fn(async (message: string, title?: string) => {
        notes.push({ message, title });
      }),
      outro: vi.fn(async () => {}),
      progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
      select: vi.fn(async () => "custom-search"),
      text: vi.fn(async () => ""),
    };

    const result = await mod.setupSearch(cfg, {} as never, prompter as never, {
      secretInputMode: "ref",
    });

    expect(result.tools?.web?.search?.provider).toBe("custom-search");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(
      (
        result.plugins?.entries?.["custom-plugin"]?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined
      )?.webSearch?.apiKey,
    ).toEqual({
      id: "CUSTOM_SEARCH_API_KEY",
      provider: "default",
      source: "env",
    });
    expect(notes.some((note) => note.message.includes("CUSTOM_SEARCH_API_KEY"))).toBe(true);
  });

  it("does not treat hard-disabled bundled providers as selectable credentials", async () => {
    mocks.resolvePluginWebSearchProviders.mockReturnValue([]);

    const cfg: OpenClawConfig = {
      plugins: {
        enabled: false,
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "fc-disabled-key",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            provider: "firecrawl",
          },
        },
      },
    };

    expect(mod.hasExistingKey(cfg, "firecrawl")).toBe(false);
    expect(mod.resolveExistingKey(cfg, "firecrawl")).toBeUndefined();
    expect(mod.applySearchProviderSelection(cfg, "firecrawl")).toBe(cfg);
  });

  it("defaults to a keyless provider when no search credentials exist", async () => {
    const duckduckgoEntry = createBundledDuckDuckGoEntry();
    mocks.resolvePluginWebSearchProviders.mockImplementation((params) =>
      params?.config ? [duckduckgoEntry] : [duckduckgoEntry],
    );

    const notes: string[] = [];
    const prompter = {
      confirm: vi.fn(async () => true),
      intro: vi.fn(async () => {}),
      multiselect: vi.fn(async () => []),
      note: vi.fn(async (message: string) => {
        notes.push(message);
      }),
      outro: vi.fn(async () => {}),
      progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
      select: vi.fn(async () => "duckduckgo"),
      text: vi.fn(async () => {
        throw new Error("text prompt should not run for keyless providers");
      }),
    };

    const result = await mod.setupSearch({} as OpenClawConfig, {} as never, prompter as never);

    expect(result.tools?.web?.search?.provider).toBe("duckduckgo");
    expect(result.plugins?.entries?.duckduckgo?.enabled).toBe(true);
    expect(notes.some((message) => message.includes("works without an API key"))).toBe(true);
  });

  it("uses the runtime onboarding search surface when no config is present", async () => {
    const firecrawlEntry = createBundledFirecrawlEntry();
    const duckduckgoEntry = createBundledDuckDuckGoEntry();
    const tavilyEntry: PluginWebSearchProviderEntry = {
      ...firecrawlEntry,
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
      envVars: ["TAVILY_API_KEY"],
      hint: "Research search",
      id: "tavily",
      label: "Tavily Search",
      pluginId: "tavily",
      signupUrl: "https://example.com/tavily",
    };
    const customEntry = createCustomProviderEntry();

    mocks.resolvePluginWebSearchProviders.mockReturnValue([
      customEntry,
      duckduckgoEntry,
      firecrawlEntry,
      tavilyEntry,
    ]);

    const options = mod.resolveSearchProviderOptions();

    expect(options.map((entry) => entry.id)).toEqual([
      "custom-search",
      "duckduckgo",
      "firecrawl",
      "tavily",
    ]);
  });
});
