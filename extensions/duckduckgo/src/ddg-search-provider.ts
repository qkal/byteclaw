import { Type } from "@sinclair/typebox";
import {
  type WebSearchProviderPlugin,
  enablePluginInConfig,
  getScopedCredentialValue,
  readNumberParam,
  readStringParam,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { runDuckDuckGoSearch } from "./ddg-client.js";

const DuckDuckGoSearchSchema = Type.Object(
  {
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        maximum: 10,
        minimum: 1,
      }),
    ),
    query: Type.String({ description: "Search query string." }),
    region: Type.Optional(
      Type.String({
        description: "Optional DuckDuckGo region code such as us-en, uk-en, or de-de.",
      }),
    ),
    safeSearch: Type.Optional(
      Type.String({
        description: "SafeSearch level: strict, moderate, or off.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    applySelectionConfig: (config) => enablePluginInConfig(config, "duckduckgo").config,
    autoDetectOrder: 100,
    createTool: (ctx) => ({
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets with no API key required.",
      execute: async (args) =>
        await runDuckDuckGoSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          region: readStringParam(args, "region"),
          safeSearch: readStringParam(args, "safeSearch") as
            | "strict"
            | "moderate"
            | "off"
            | undefined,
        }),
      parameters: DuckDuckGoSearchSchema,
    }),
    credentialPath: "",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    envVars: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "duckduckgo"),
    hint: "Free web search fallback with no API key required",
    id: "duckduckgo",
    inactiveSecretPaths: [],
    label: "DuckDuckGo Search (experimental)",
    placeholder: "(no key needed)",
    requiresCredential: false,
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "duckduckgo", value),
    signupUrl: "https://duckduckgo.com/",
  };
}
