import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { listSearchProviderOptions, setupSearch } from "./onboard-search.js";

interface WebSearchConfigRecord {
  plugins?: {
    entries?: Record<
      string,
      { enabled?: boolean; config?: { webSearch?: Record<string, unknown> } }
    >;
  };
}

const SEARCH_PROVIDER_PLUGINS: Record<
  string,
  { pluginId: string; envVars: string[]; label: string; credentialLabel?: string }
> = {
  brave: { envVars: ["BRAVE_API_KEY"], label: "Brave Search", pluginId: "brave" },
  firecrawl: { envVars: ["FIRECRAWL_API_KEY"], label: "Firecrawl", pluginId: "firecrawl" },
  gemini: { envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], label: "Gemini", pluginId: "google" },
  grok: { envVars: ["XAI_API_KEY"], label: "Grok", pluginId: "xai" },
  kimi: {
    credentialLabel: "Moonshot / Kimi API key",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    label: "Kimi",
    pluginId: "moonshot",
  },
  perplexity: {
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    label: "Perplexity",
    pluginId: "perplexity",
  },
  tavily: { envVars: ["TAVILY_API_KEY"], label: "Tavily", pluginId: "tavily" },
};

function getWebSearchConfig(config: OpenClawConfig | undefined, pluginId: string) {
  return (config as WebSearchConfigRecord | undefined)?.plugins?.entries?.[pluginId]?.config
    ?.webSearch;
}

function ensureWebSearchConfig(config: OpenClawConfig, pluginId: string) {
  const entries = ((config.plugins ??= {}).entries ??= {});
  const pluginEntry = (entries[pluginId] ??= {}) as {
    enabled?: boolean;
    config?: { webSearch?: Record<string, unknown> };
  };
  pluginEntry.config ??= {};
  pluginEntry.config.webSearch ??= {};
  return pluginEntry.config.webSearch;
}

function createSearchProviderEntry(id: string): PluginWebSearchProviderEntry {
  const metadata = SEARCH_PROVIDER_PLUGINS[id];
  if (!metadata) {
    throw new Error(`missing search provider fixture: ${id}`);
  }
  const entry: PluginWebSearchProviderEntry = {
    applySelectionConfig: (config) => {
      const next: OpenClawConfig = { ...config, plugins: { ...config.plugins } };
      const entries = { ...next.plugins?.entries } as NonNullable<
        NonNullable<OpenClawConfig["plugins"]>["entries"]
      >;
      entries[metadata.pluginId] = { ...entries[metadata.pluginId], enabled: true };
      next.plugins = { ...next.plugins, entries };
      return next;
    },
    createTool: () => null,
    credentialLabel:
      metadata.credentialLabel ??
      (id === "gemini" ? "Google Gemini API key" : `${metadata.label} API key`),
    credentialPath: `plugins.entries.${metadata.pluginId}.config.webSearch.apiKey`,
    envVars: metadata.envVars,
    getConfiguredCredentialValue: (config) => getWebSearchConfig(config, metadata.pluginId)?.apiKey,
    getCredentialValue: () => undefined,
    hint: `${metadata.label} web search`,
    id: id as never,
    label: metadata.label,
    onboardingScopes: ["text-inference"],
    placeholder: `${id}-key`,
    pluginId: metadata.pluginId,
    setConfiguredCredentialValue: (config, value) => {
      ensureWebSearchConfig(config, metadata.pluginId).apiKey = value;
    },
    setCredentialValue: () => {},
    signupUrl: `https://example.com/${id}`,
  };
  if (id === "kimi") {
    entry.runSetup = async ({ config, prompter }) => {
      const baseUrl = String(
        await prompter.select({
          initialValue: "https://api.moonshot.ai/v1",
          message: "Moonshot endpoint",
          options: [{ label: "Moonshot", value: "https://api.moonshot.ai/v1" }],
        }),
      );
      const modelChoice = String(
        await prompter.select({
          initialValue: "__keep__",
          message: "Moonshot web-search model",
          options: [{ label: "Keep default", value: "__keep__" }],
        }),
      );
      const webSearch = ensureWebSearchConfig(config, metadata.pluginId);
      webSearch.baseUrl = baseUrl;
      webSearch.model = modelChoice === "__keep__" ? "kimi-k2.5" : modelChoice;
      return config;
    };
  }
  return entry;
}

const searchProviderFixture = vi.hoisted(() => ({
  resolvePluginWebSearchProviders: vi.fn(() =>
    ["brave", "firecrawl", "gemini", "grok", "kimi", "perplexity", "tavily"].map((id) =>
      createSearchProviderEntry(id),
    ),
  ),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: searchProviderFixture.resolvePluginWebSearchProviders,
}));

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
  log: vi.fn(),
};

const SEARCH_PROVIDER_ENV_VARS = [
  "BRAVE_API_KEY",
  "FIRECRAWL_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "XAI_API_KEY",
] as const;

let originalSearchProviderEnv: Partial<Record<(typeof SEARCH_PROVIDER_ENV_VARS)[number], string>> =
  {};

function createPrompter(params: {
  selectValue?: string;
  selectValues?: string[];
  textValue?: string;
}): {
  prompter: WizardPrompter;
  notes: { title?: string; message: string }[];
} {
  const notes: { title?: string; message: string }[] = [];
  const remainingSelectValues = [...(params.selectValues ?? [])];
  const prompter: WizardPrompter = {
    confirm: vi.fn(async () => true),
    intro: vi.fn(async () => {}),
    multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ message, title });
    }),
    outro: vi.fn(async () => {}),
    progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    select: vi.fn(
      async () => remainingSelectValues.shift() ?? params.selectValue ?? "perplexity",
    ) as unknown as WizardPrompter["select"],
    text: vi.fn(async () => params.textValue ?? ""),
  };
  return { notes, prompter };
}

function createPerplexityConfig(apiKey: string, enabled?: boolean): OpenClawConfig {
  return {
    plugins: {
      entries: {
        perplexity: {
          config: {
            webSearch: {
              apiKey,
            },
          },
        },
      },
    },
    tools: {
      web: {
        search: {
          provider: "perplexity",
          ...(enabled === undefined ? {} : { enabled }),
        },
      },
    },
  };
}

function pluginWebSearchApiKey(config: OpenClawConfig, pluginId: string): unknown {
  const entry = (
    config.plugins?.entries as
      | Record<string, { config?: { webSearch?: { apiKey?: unknown } } }>
      | undefined
  )?.[pluginId];
  return entry?.config?.webSearch?.apiKey;
}

function createDisabledFirecrawlConfig(apiKey?: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: {
          enabled: false,
          ...(apiKey
            ? {
                config: {
                  webSearch: {
                    apiKey,
                  },
                },
              }
            : {}),
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
}

function readFirecrawlPluginApiKey(config: OpenClawConfig): string | undefined {
  const pluginConfig = config.plugins?.entries?.firecrawl?.config as
    | {
        webSearch?: {
          apiKey?: string;
        };
      }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

async function runBlankPerplexityKeyEntry(
  apiKey: string,
  enabled?: boolean,
): Promise<OpenClawConfig> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({
    selectValue: "perplexity",
    textValue: "",
  });
  return setupSearch(cfg, runtime, prompter);
}

async function runQuickstartPerplexitySetup(
  apiKey: string,
  enabled?: boolean,
): Promise<{ result: OpenClawConfig; prompter: WizardPrompter }> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({ selectValue: "perplexity" });
  const result = await setupSearch(cfg, runtime, prompter, {
    quickstartDefaults: true,
  });
  return { prompter, result };
}

describe("setupSearch", () => {
  beforeEach(() => {
    originalSearchProviderEnv = Object.fromEntries(
      SEARCH_PROVIDER_ENV_VARS.map((key) => [key, process.env[key]]),
    );
    for (const key of SEARCH_PROVIDER_ENV_VARS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of SEARCH_PROVIDER_ENV_VARS) {
      const value = originalSearchProviderEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns config unchanged when user skips", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result).toBe(cfg);
  });

  it("sets provider and key for perplexity", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "perplexity",
      textValue: "pplx-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("pplx-test-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.perplexity?.enabled).toBe(true);
  });

  it("sets provider and key for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "brave")).toBe("BSA-test-key");
    expect(result.plugins?.entries?.brave?.enabled).toBe(true);
  });

  it("sets provider and key for gemini", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "gemini",
      textValue: "AIza-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("gemini");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "google")).toBe("AIza-test");
    expect(result.plugins?.entries?.google?.enabled).toBe(true);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Google Gemini API key",
      }),
    );
  });

  it("sets provider and key for firecrawl and enables the plugin", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "firecrawl",
      textValue: "fc-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "firecrawl")).toBe("fc-test-key");
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
  });

  it("re-enables firecrawl and persists its plugin config when selected from disabled state", async () => {
    const cfg = createDisabledFirecrawlConfig();
    const { prompter } = createPrompter({
      selectValue: "firecrawl",
      textValue: "fc-disabled-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(readFirecrawlPluginApiKey(result)).toBe("fc-disabled-key");
  });

  it("sets provider and key for grok", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "grok",
      textValue: "xai-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("grok");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "xai")).toBe("xai-test");
    expect(result.plugins?.entries?.xai?.enabled).toBe(true);
  });

  it("sets provider and key for kimi", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValues: ["kimi", "https://api.moonshot.ai/v1", "__keep__"],
      textValue: "sk-moonshot",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    const kimiWebSearchConfig = result.plugins?.entries?.moonshot?.config?.webSearch as
      | {
          baseUrl?: string;
          model?: string;
        }
      | undefined;
    expect(result.tools?.web?.search?.provider).toBe("kimi");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "moonshot")).toBe("sk-moonshot");
    expect(result.plugins?.entries?.moonshot?.enabled).toBe(true);
    expect(kimiWebSearchConfig?.baseUrl).toBe("https://api.moonshot.ai/v1");
    expect(kimiWebSearchConfig?.model).toBe("kimi-k2.5");
  });

  it("sets provider and key for tavily and enables the plugin", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "tavily",
      textValue: "tvly-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(pluginWebSearchApiKey(result, "tavily")).toBe("tvly-test-key");
    expect(result.plugins?.entries?.tavily?.enabled).toBe(true);
  });

  it("shows missing-key note when no key is provided and no env var", async () => {
    const original = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter, notes } = createPrompter({
        selectValue: "brave",
        textValue: "",
      });
      const result = await setupSearch(cfg, runtime, prompter);
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
      const missingNote = notes.find((n) => n.message.includes("No Brave Search API key stored"));
      expect(missingNote).toBeDefined();
    } finally {
      if (original === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = original;
      }
    }
  });

  it("keeps existing key when user leaves input blank", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // Pragma: allowlist secret
    );
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
  });

  it("advanced preserves enabled:false when keeping existing key", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // Pragma: allowlist secret
      false,
    );
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
  });

  it("quickstart skips key prompt when config key exists", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // Pragma: allowlist secret
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart preserves enabled:false when search was intentionally disabled", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // Pragma: allowlist secret
      false,
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(pluginWebSearchApiKey(result, "perplexity")).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart skips key prompt when canonical plugin config key exists", async () => {
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: "tvly-existing-key",
              },
            },
            enabled: true,
          },
        },
      },
      tools: {
        web: {
          search: {
            provider: "tavily",
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "tavily" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(pluginWebSearchApiKey(result, "tavily")).toBe("tvly-existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart falls through to key prompt when no key and no env var", async () => {
    const original = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "grok", textValue: "" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("grok");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = original;
      }
    }
  });

  it("uses provider-specific credential copy for kimi in onboarding", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "kimi",
      textValue: "",
    });
    await setupSearch(cfg, runtime, prompter);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Moonshot / Kimi API key",
      }),
    );
  });

  it("quickstart skips key prompt when env var is available", async () => {
    const orig = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "env-brave-key"; // Pragma: allowlist secret
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "brave" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = orig;
      }
    }
  });

  it("quickstart detects an existing firecrawl key even when the plugin is disabled", async () => {
    const cfg = createDisabledFirecrawlConfig("fc-configured-key");
    const { prompter } = createPrompter({ selectValue: "firecrawl" });
    const result = await setupSearch(cfg, runtime, prompter, {
      quickstartDefaults: true,
    });
    expect(prompter.text).not.toHaveBeenCalled();
    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.firecrawl?.enabled).toBe(true);
    expect(readFirecrawlPluginApiKey(result)).toBe("fc-configured-key");
  });

  it("preserves disabled firecrawl plugin state and allowlist when web search stays disabled", async () => {
    const original = process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_KEY = "env-firecrawl-key"; // Pragma: allowlist secret
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["google"],
        entries: {
          firecrawl: {
            enabled: false,
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: false,
            provider: "firecrawl",
          },
        },
      },
    };
    try {
      const { prompter } = createPrompter({ selectValue: "firecrawl" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).not.toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("firecrawl");
      expect(result.tools?.web?.search?.enabled).toBe(false);
      expect(result.plugins?.entries?.firecrawl?.enabled).toBe(false);
      expect(result.plugins?.allow).toEqual(["google"]);
    } finally {
      if (original === undefined) {
        delete process.env.FIRECRAWL_API_KEY;
      } else {
        process.env.FIRECRAWL_API_KEY = original;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for perplexity", async () => {
    const originalPerplexity = process.env.PERPLEXITY_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "perplexity" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // Pragma: allowlist secret
      });
      expect(result.tools?.web?.search?.provider).toBe("perplexity");
      expect(pluginWebSearchApiKey(result, "perplexity")).toEqual({
        id: "PERPLEXITY_API_KEY",
        provider: "default",
        source: "env", // Pragma: allowlist secret
      });
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (originalPerplexity === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = originalPerplexity;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  it("prefers detected OPENROUTER_API_KEY SecretRef for perplexity ref mode", async () => {
    const originalPerplexity = process.env.PERPLEXITY_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "perplexity" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // Pragma: allowlist secret
      });
      expect(pluginWebSearchApiKey(result, "perplexity")).toEqual({
        id: "OPENROUTER_API_KEY",
        provider: "default",
        source: "env", // Pragma: allowlist secret
      });
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (originalPerplexity === undefined) {
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = originalPerplexity;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "brave" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // Pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(pluginWebSearchApiKey(result, "brave")).toEqual({
      id: "BRAVE_API_KEY",
      provider: "default",
      source: "env",
    });
    expect(result.plugins?.entries?.brave?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores env-backed SecretRef when secretInputMode=ref for tavily", async () => {
    const original = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    const cfg: OpenClawConfig = {};
    try {
      const { prompter } = createPrompter({ selectValue: "tavily" });
      const result = await setupSearch(cfg, runtime, prompter, {
        secretInputMode: "ref", // Pragma: allowlist secret
      });
      expect(result.tools?.web?.search?.provider).toBe("tavily");
      expect(pluginWebSearchApiKey(result, "tavily")).toEqual({
        id: "TAVILY_API_KEY",
        provider: "default",
        source: "env",
      });
      expect(result.plugins?.entries?.tavily?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = original;
      }
    }
  });

  it("stores plaintext key when secretInputMode is unset", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-plain",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(pluginWebSearchApiKey(result, "brave")).toBe("BSA-plain");
  });

  it("exports search providers in alphabetical order", () => {
    const providers = listSearchProviderOptions();
    const values = providers.map((e) => e.id);
    expect(values).toEqual([...values].toSorted());
    expect(values).toEqual(
      expect.arrayContaining([
        "brave",
        "firecrawl",
        "gemini",
        "grok",
        "kimi",
        "perplexity",
        "tavily",
      ]),
    );
  });
});
