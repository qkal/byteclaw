import { isAtLeast, parseSemver } from "../infra/runtime-guard.js";

export const MIN_HOST_VERSION_FORMAT =
  'openclaw.install.minHostVersion must use a semver floor in the form ">=x.y.z"';
const MIN_HOST_VERSION_RE = /^>=(\d+)\.(\d+)\.(\d+)$/;

export interface MinHostVersionRequirement {
  raw: string;
  minimumLabel: string;
}

import { normalizeOptionalString } from "../shared/string-coerce.js";

export type MinHostVersionCheckResult =
  | { ok: true; requirement: MinHostVersionRequirement | null }
  | { ok: false; kind: "invalid"; error: string }
  | { ok: false; kind: "unknown_host_version"; requirement: MinHostVersionRequirement }
  | {
      ok: false;
      kind: "incompatible";
      requirement: MinHostVersionRequirement;
      currentVersion: string;
    };

export function parseMinHostVersionRequirement(raw: unknown): MinHostVersionRequirement | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(MIN_HOST_VERSION_RE);
  if (!match) {
    return null;
  }
  const minimumLabel = `${match[1]}.${match[2]}.${match[3]}`;
  if (!parseSemver(minimumLabel)) {
    return null;
  }
  return {
    minimumLabel,
    raw: trimmed,
  };
}

export function validateMinHostVersion(raw: unknown): string | null {
  if (raw === undefined) {
    return null;
  }
  return parseMinHostVersionRequirement(raw) ? null : MIN_HOST_VERSION_FORMAT;
}

export function checkMinHostVersion(params: {
  currentVersion: string | undefined;
  minHostVersion: unknown;
}): MinHostVersionCheckResult {
  if (params.minHostVersion === undefined) {
    return { ok: true, requirement: null };
  }
  const requirement = parseMinHostVersionRequirement(params.minHostVersion);
  if (!requirement) {
    return { error: MIN_HOST_VERSION_FORMAT, kind: "invalid", ok: false };
  }
  const currentVersion = normalizeOptionalString(params.currentVersion) || "unknown";
  const currentSemver = parseSemver(currentVersion);
  if (!currentSemver) {
    return {
      kind: "unknown_host_version",
      ok: false,
      requirement,
    };
  }
  const minimumSemver = parseSemver(requirement.minimumLabel)!;
  if (!isAtLeast(currentSemver, minimumSemver)) {
    return {
      currentVersion,
      kind: "incompatible",
      ok: false,
      requirement,
    };
  }
  return { ok: true, requirement };
}
