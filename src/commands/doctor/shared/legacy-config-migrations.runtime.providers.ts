import {
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
  defineLegacyConfigMigration,
} from "../../../config/legacy.shared.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

const X_SEARCH_RULE: LegacyConfigRule = {
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
  path: ["tools", "web", "x_search", "apiKey"],
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    apply: (raw, changes) => {
      const migrated = migrateLegacyXSearchConfig(raw);
      if (!migrated.changes.length) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
    describe: "Move legacy x_search auth into the xAI plugin webSearch config",
    id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
    legacyRules: [X_SEARCH_RULE],
  }),
];
