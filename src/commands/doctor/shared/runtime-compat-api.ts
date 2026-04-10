import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../../config/types.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { normalizeCompatibilityConfigValues } from "./legacy-config-core-migrate.js";

export function applyRuntimeLegacyConfigMigrations(raw: unknown): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { changes: [], next: null };
  }

  const original = raw as Record<string, unknown>;
  const migrated = applyLegacyDoctorMigrations(original);
  const base = (migrated.next ?? original) as OpenClawConfig;
  const normalized = normalizeCompatibilityConfigValues(base);
  const next = normalized.config as OpenClawConfig & Record<string, unknown>;
  const changes = [...migrated.changes, ...normalized.changes];

  if (changes.length === 0 || isDeepStrictEqual(next, original)) {
    return { changes: [], next: null };
  }
  return { changes, next };
}
