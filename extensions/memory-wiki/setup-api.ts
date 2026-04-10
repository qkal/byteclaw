import { definePluginEntry } from "./api.js";
import { migrateMemoryWikiLegacyConfig } from "./src/config-compat.js";

export default definePluginEntry({
  description: "Lightweight Memory Wiki setup hooks",
  id: "memory-wiki",
  name: "Memory Wiki Setup",
  register(api) {
    api.registerConfigMigration((config) => migrateMemoryWikiLegacyConfig(config));
  },
});
