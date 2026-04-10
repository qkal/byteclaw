import { Type } from "@sinclair/typebox";
import {
  type WebSearchProviderPlugin,
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { runSearxngSearch } from "./searxng-client.js";

const SearxngSearchSchema = Type.Object(
  {
    categories: Type.Optional(
      Type.String({
        description:
          "Optional comma-separated search categories such as general, news, or science.",
      }),
    ),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        maximum: 10,
        minimum: 1,
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "Optional language code for results such as en, de, or fr.",
      }),
    ),
    query: Type.String({ description: "Search query string." }),
  },
  { additionalProperties: false },
);

export function createSearxngWebSearchProvider(): WebSearchProviderPlugin {
  return {
    applySelectionConfig: (config) => enablePluginInConfig(config, "searxng").config,
    autoDetectOrder: 200,
    createTool: (ctx) => ({
      description:
        "Search the web using a self-hosted SearXNG instance. Returns titles, URLs, and snippets.",
      execute: async (args) =>
        await runSearxngSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          categories: readStringParam(args, "categories"),
          language: readStringParam(args, "language"),
        }),
      parameters: SearxngSearchSchema,
    }),
    credentialLabel: "SearXNG Base URL",
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    envVars: ["SEARXNG_BASE_URL"],
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "searxng")?.baseUrl,
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "searxng"),
    hint: "Self-hosted meta-search with no API key required",
    id: "searxng",
    inactiveSecretPaths: ["plugins.entries.searxng.config.webSearch.baseUrl"],
    label: "SearXNG Search",
    onboardingScopes: ["text-inference"],
    placeholder: "http://localhost:8080",
    requiresCredential: true,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "searxng", "baseUrl", value);
    },
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "searxng", value),
    signupUrl: "https://docs.searxng.org/",
  };
}
