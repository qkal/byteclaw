import { expect } from "vitest";
import { restoreRedactedValues as restoreRedactedValues_orig } from "./redact-snapshot.js";
import type { ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

export type TestSnapshot<TConfig extends Record<string, unknown>> = ConfigFileSnapshot & {
  parsed: TConfig;
  sourceConfig: TConfig;
  resolved: TConfig;
  runtimeConfig: TConfig;
  config: TConfig;
};

export function makeSnapshot<TConfig extends Record<string, unknown>>(
  config: TConfig,
  raw?: string,
): TestSnapshot<TConfig> {
  return {
    config: config as ConfigFileSnapshot["config"],
    exists: true,
    hash: "abc123",
    issues: [],
    legacyIssues: [],
    parsed: config,
    path: "/home/user/.openclaw/config.json5",
    raw: raw ?? JSON.stringify(config),
    resolved: config as ConfigFileSnapshot["resolved"],
    runtimeConfig: config as ConfigFileSnapshot["runtimeConfig"],
    sourceConfig: config as ConfigFileSnapshot["sourceConfig"],
    valid: true,
    warnings: [],
  } as unknown as TestSnapshot<TConfig>;
}

export function restoreRedactedValues<TOriginal>(
  incoming: unknown,
  original: TOriginal,
  hints?: ConfigUiHints,
): TOriginal {
  const result = restoreRedactedValues_orig(incoming, original, hints);
  expect(result.ok).toBe(true);
  return result.result as TOriginal;
}
