import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDuckDuckGoWebSearchProvider } from "./src/ddg-search-provider.js";

export default definePluginEntry({
  description: "Bundled DuckDuckGo web search plugin",
  id: "duckduckgo",
  name: "DuckDuckGo Plugin",
  register(api) {
    api.registerWebSearchProvider(createDuckDuckGoWebSearchProvider());
  },
});
