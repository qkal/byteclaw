import crypto from "node:crypto";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function buildTestConfigSnapshot(params: {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: OpenClawConfig;
  issues: ConfigFileSnapshot["issues"];
  warnings?: ConfigFileSnapshot["warnings"];
  legacyIssues: ConfigFileSnapshot["legacyIssues"];
}): ConfigFileSnapshot {
  return {
    config: params.config,
    exists: params.exists,
    hash: hashConfigRaw(params.raw),
    issues: params.issues,
    legacyIssues: params.legacyIssues,
    parsed: params.parsed,
    path: params.path,
    raw: params.raw,
    resolved: params.config,
    runtimeConfig: params.config,
    sourceConfig: params.config,
    valid: params.valid,
    warnings: params.warnings ?? [],
  };
}
