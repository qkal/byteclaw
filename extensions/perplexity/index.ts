import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createPerplexityWebSearchProvider } from "./src/perplexity-web-search-provider.js";

export default definePluginEntry({
  description: "Bundled Perplexity plugin",
  id: "perplexity",
  name: "Perplexity Plugin",
  register(api) {
    api.registerWebSearchProvider(createPerplexityWebSearchProvider());
  },
});
