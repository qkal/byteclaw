import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createExaWebSearchProvider } from "./src/exa-web-search-provider.js";

export default definePluginEntry({
  description: "Bundled Exa web search plugin",
  id: "exa",
  name: "Exa Plugin",
  register(api) {
    api.registerWebSearchProvider(createExaWebSearchProvider());
  },
});
