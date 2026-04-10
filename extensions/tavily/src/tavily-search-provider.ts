import { Type } from "@sinclair/typebox";
import {
  type WebSearchProviderPlugin,
  enablePluginInConfig,
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { runTavilySearch } from "./tavily-client.js";

const GenericTavilySearchSchema = Type.Object(
  {
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        maximum: 20,
        minimum: 1,
      }),
    ),
    query: Type.String({ description: "Search query string." }),
  },
  { additionalProperties: false },
);

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    applySelectionConfig: (config) => enablePluginInConfig(config, "tavily").config,
    autoDetectOrder: 70,
    createTool: (ctx) => ({
      description:
        "Search the web using Tavily. Returns structured results with snippets. Use tavily_search for Tavily-specific options like search depth, topic filtering, or AI answers.",
      execute: async (args) =>
        await runTavilySearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          maxResults: typeof args.count === "number" ? args.count : undefined,
        }),
      parameters: GenericTavilySearchSchema,
    }),
    credentialLabel: "Tavily API key",
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    envVars: ["TAVILY_API_KEY"],
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "tavily")?.apiKey,
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "tavily"),
    hint: "Structured results with domain filters and AI answer summaries",
    id: "tavily",
    inactiveSecretPaths: ["plugins.entries.tavily.config.webSearch.apiKey"],
    label: "Tavily Search",
    onboardingScopes: ["text-inference"],
    placeholder: "tvly-...",
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "tavily", "apiKey", value);
    },
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "tavily", value),
    signupUrl: "https://tavily.com/",
  };
}
