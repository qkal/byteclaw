import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBraveWebSearchProvider } from "./src/brave-web-search-provider.js";

export default definePluginEntry({
  description: "Bundled Brave plugin",
  id: "brave",
  name: "Brave Plugin",
  register(api) {
    api.registerWebSearchProvider(createBraveWebSearchProvider());
  },
});
