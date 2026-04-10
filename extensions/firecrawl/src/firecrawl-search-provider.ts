import { Type } from "@sinclair/typebox";
import {
  type WebSearchProviderPlugin,
  enablePluginInConfig,
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { runFirecrawlSearch } from "./firecrawl-client.js";

const GenericFirecrawlSearchSchema = Type.Object(
  {
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        maximum: 10,
        minimum: 1,
      }),
    ),
    query: Type.String({ description: "Search query string." }),
  },
  { additionalProperties: false },
);

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  return {
    applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
    autoDetectOrder: 60,
    createTool: (ctx) => ({
      description:
        "Search the web using Firecrawl. Returns structured results with snippets from Firecrawl Search. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
      execute: async (args) =>
        await runFirecrawlSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        }),
      parameters: GenericFirecrawlSearchSchema,
    }),
    credentialLabel: "Firecrawl API key",
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    envVars: ["FIRECRAWL_API_KEY"],
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "firecrawl")?.apiKey,
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "firecrawl"),
    hint: "Structured results with optional result scraping",
    id: "firecrawl",
    inactiveSecretPaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
    label: "Firecrawl Search",
    onboardingScopes: ["text-inference"],
    placeholder: "fc-...",
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "firecrawl", "apiKey", value);
    },
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "firecrawl", value),
    signupUrl: "https://www.firecrawl.dev/",
  };
}
