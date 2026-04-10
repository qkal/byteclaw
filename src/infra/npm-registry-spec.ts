import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const EXACT_SEMVER_VERSION_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ParsedRegistryNpmSpec {
  name: string;
  raw: string;
  selector?: string;
  selectorKind: "none" | "exact-version" | "tag";
  selectorIsPrerelease: boolean;
}

function parseRegistryNpmSpecInternal(
  rawSpec: string,
): { ok: true; parsed: ParsedRegistryNpmSpec } | { ok: false; error: string } {
  const spec = rawSpec.trim();
  if (!spec) {
    return { error: "missing npm spec", ok: false };
  }
  if (/\s/.test(spec)) {
    return { error: "unsupported npm spec: whitespace is not allowed", ok: false };
  }
  // Registry-only: no URLs, git, file, or alias protocols.
  // Keep strict: this runs on the gateway host.
  if (spec.includes("://")) {
    return { error: "unsupported npm spec: URLs are not allowed", ok: false };
  }
  if (spec.includes("#")) {
    return { error: "unsupported npm spec: git refs are not allowed", ok: false };
  }
  if (spec.includes(":")) {
    return { error: "unsupported npm spec: protocol specs are not allowed", ok: false };
  }

  const at = spec.lastIndexOf("@");
  const hasSelector = at > 0;
  const name = hasSelector ? spec.slice(0, at) : spec;
  const selector = hasSelector ? spec.slice(at + 1) : "";

  const unscopedName = /^[a-z0-9][a-z0-9-._~]*$/;
  const scopedName = /^@[a-z0-9][a-z0-9-._~]*\/[a-z0-9][a-z0-9-._~]*$/;
  const isValidName = name.startsWith("@") ? scopedName.test(name) : unscopedName.test(name);
  if (!isValidName) {
    return {
      error: "unsupported npm spec: expected <name> or <name>@<version> from the npm registry",
      ok: false,
    };
  }
  if (!hasSelector) {
    return {
      ok: true,
      parsed: {
        name,
        raw: spec,
        selectorIsPrerelease: false,
        selectorKind: "none",
      },
    };
  }
  if (!selector) {
    return { error: "unsupported npm spec: missing version/tag after @", ok: false };
  }
  if (/[\\/]/.test(selector)) {
    return { error: "unsupported npm spec: invalid version/tag", ok: false };
  }
  const exactVersionMatch = EXACT_SEMVER_VERSION_RE.exec(selector);
  if (exactVersionMatch) {
    return {
      ok: true,
      parsed: {
        name,
        raw: spec,
        selector,
        selectorIsPrerelease: Boolean(exactVersionMatch[4]),
        selectorKind: "exact-version",
      },
    };
  }
  if (!DIST_TAG_RE.test(selector)) {
    return {
      error: "unsupported npm spec: use an exact version or dist-tag (ranges are not allowed)",
      ok: false,
    };
  }
  return {
    ok: true,
    parsed: {
      name,
      raw: spec,
      selector,
      selectorIsPrerelease: false,
      selectorKind: "tag",
    },
  };
}

export function parseRegistryNpmSpec(rawSpec: string): ParsedRegistryNpmSpec | null {
  const parsed = parseRegistryNpmSpecInternal(rawSpec);
  return parsed.ok ? parsed.parsed : null;
}

export function validateRegistryNpmSpec(rawSpec: string): string | null {
  const parsed = parseRegistryNpmSpecInternal(rawSpec);
  return parsed.ok ? null : parsed.error;
}

export function isExactSemverVersion(value: string): boolean {
  return EXACT_SEMVER_VERSION_RE.test(value.trim());
}

export function isPrereleaseSemverVersion(value: string): boolean {
  const match = EXACT_SEMVER_VERSION_RE.exec(value.trim());
  return Boolean(match?.[4]);
}

export function isPrereleaseResolutionAllowed(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedVersion?: string;
}): boolean {
  if (!params.resolvedVersion || !isPrereleaseSemverVersion(params.resolvedVersion)) {
    return true;
  }
  if (params.spec.selectorKind === "none") {
    return false;
  }
  if (params.spec.selectorKind === "exact-version") {
    return params.spec.selectorIsPrerelease;
  }
  return normalizeLowercaseStringOrEmpty(params.spec.selector) !== "latest";
}

export function formatPrereleaseResolutionError(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedVersion: string;
}): string {
  const selectorHint =
    params.spec.selectorKind === "none" ||
    normalizeLowercaseStringOrEmpty(params.spec.selector) === "latest"
      ? `Use "${params.spec.name}@beta" (or another prerelease tag) or an exact prerelease version to opt in explicitly.`
      : `Use an explicit prerelease tag or exact prerelease version if you want prerelease installs.`;
  return `Resolved ${params.spec.raw} to prerelease version ${params.resolvedVersion}, but prereleases are only installed when explicitly requested. ${selectorHint}`;
}
