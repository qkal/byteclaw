import {
  type WebSearchProviderPlugin,
  createWebSearchProviderContractFields,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.tavily.config.webSearch.apiKey";

  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured results with domain filters and AI answer summaries",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Tavily API key",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    autoDetectOrder: 70,
    credentialPath,
    ...createWebSearchProviderContractFields({
      configuredCredential: { pluginId: "tavily" },
      credentialPath,
      searchCredential: { scopeId: "tavily", type: "scoped" },
      selectionPluginId: "tavily",
    }),
    createTool: () => null,
  };
}
