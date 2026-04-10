import { type AnyAgentTool, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTavilyExtractTool } from "./src/tavily-extract-tool.js";
import { createTavilyWebSearchProvider } from "./src/tavily-search-provider.js";
import { createTavilySearchTool } from "./src/tavily-search-tool.js";

export default definePluginEntry({
  description: "Bundled Tavily search and extract plugin",
  id: "tavily",
  name: "Tavily Plugin",
  register(api) {
    api.registerWebSearchProvider(createTavilyWebSearchProvider());
    api.registerTool(createTavilySearchTool(api) as AnyAgentTool);
    api.registerTool(createTavilyExtractTool(api) as AnyAgentTool);
  },
});
