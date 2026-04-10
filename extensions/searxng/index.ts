import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSearxngWebSearchProvider } from "./src/searxng-search-provider.js";

export default definePluginEntry({
  description: "Bundled SearXNG web search plugin",
  id: "searxng",
  name: "SearXNG Plugin",
  register(api) {
    api.registerWebSearchProvider(createSearxngWebSearchProvider());
  },
});
