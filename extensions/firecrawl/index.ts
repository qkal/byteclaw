import { type AnyAgentTool, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createFirecrawlWebFetchProvider } from "./src/firecrawl-fetch-provider.js";
import { createFirecrawlScrapeTool } from "./src/firecrawl-scrape-tool.js";
import { createFirecrawlWebSearchProvider } from "./src/firecrawl-search-provider.js";
import { createFirecrawlSearchTool } from "./src/firecrawl-search-tool.js";

export default definePluginEntry({
  description: "Bundled Firecrawl search and scrape plugin",
  id: "firecrawl",
  name: "Firecrawl Plugin",
  register(api) {
    api.registerWebFetchProvider(createFirecrawlWebFetchProvider());
    api.registerWebSearchProvider(createFirecrawlWebSearchProvider());
    api.registerTool(createFirecrawlSearchTool(api) as AnyAgentTool);
    api.registerTool(createFirecrawlScrapeTool(api) as AnyAgentTool);
  },
});
