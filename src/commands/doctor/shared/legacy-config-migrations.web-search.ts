import {
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
  defineLegacyConfigMigration,
} from "../../../config/legacy.shared.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebSearchConfig,
} from "./legacy-web-search-migrate.js";

const LEGACY_WEB_SEARCH_RULES: LegacyConfigRule[] = [
  {
    match: (_value, root) => listLegacyWebSearchConfigPaths(root).length > 0,
    message:
      'tools.web.search provider-owned config moved to plugins.entries.<plugin>.config.webSearch. Run "openclaw doctor --fix".',
    path: ["tools", "web", "search"],
    requireSourceLiteral: true,
  },
];

function replaceRootRecord(
  target: Record<string, unknown>,
  replacement: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, replacement);
}

export const LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    apply: (raw, changes) => {
      const migrated = migrateLegacyWebSearchConfig(raw);
      if (migrated.changes.length === 0) {
        return;
      }
      replaceRootRecord(raw, migrated.config);
      changes.push(...migrated.changes);
    },
    describe:
      "Move legacy tools.web.search provider-owned config into plugins.entries.<plugin>.config.webSearch",
    id: "tools.web.search-provider-config->plugins.entries",
    legacyRules: LEGACY_WEB_SEARCH_RULES,
  }),
];
