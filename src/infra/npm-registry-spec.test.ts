import { describe, expect, it } from "vitest";
import {
  formatPrereleaseResolutionError,
  isExactSemverVersion,
  isPrereleaseResolutionAllowed,
  isPrereleaseSemverVersion,
  parseRegistryNpmSpec,
  validateRegistryNpmSpec,
} from "./npm-registry-spec.js";

function parseSpecOrThrow(spec: string) {
  const parsed = parseRegistryNpmSpec(spec);
  expect(parsed).not.toBeNull();
  return parsed!;
}

describe("npm registry spec validation", () => {
  it.each([
    "@openclaw/voice-call",
    "@openclaw/voice-call@1.2.3",
    "@openclaw/voice-call@1.2.3-beta.4",
    "@openclaw/voice-call@latest",
    "@openclaw/voice-call@beta",
  ])("accepts %s", (spec) => {
    expect(validateRegistryNpmSpec(spec)).toBeNull();
  });

  it.each([
    {
      expected: "exact version or dist-tag",
      spec: "@openclaw/voice-call@^1.2.3",
    },
    {
      expected: "exact version or dist-tag",
      spec: "@openclaw/voice-call@~1.2.3",
    },
    {
      expected: "URLs are not allowed",
      spec: "https://npmjs.org/pkg.tgz",
    },
    {
      expected: "URLs are not allowed",
      spec: "git+ssh://github.com/openclaw/openclaw",
    },
    {
      expected: "missing version/tag after @",
      spec: "@openclaw/voice-call@",
    },
    {
      expected: "invalid version/tag",
      spec: "@openclaw/voice-call@../beta",
    },
  ])("rejects %s", ({ spec, expected }) => {
    expect(validateRegistryNpmSpec(spec)).toContain(expected);
  });
});

describe("npm registry spec parsing helpers", () => {
  it.each([
    {
      expected: {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call",
        selectorIsPrerelease: false,
        selectorKind: "none",
      },
      spec: "@openclaw/voice-call",
    },
    {
      expected: {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call@beta",
        selector: "beta",
        selectorIsPrerelease: false,
        selectorKind: "tag",
      },
      spec: "@openclaw/voice-call@beta",
    },
    {
      expected: {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call@1.2.3-beta.1",
        selector: "1.2.3-beta.1",
        selectorIsPrerelease: true,
        selectorKind: "exact-version",
      },
      spec: "@openclaw/voice-call@1.2.3-beta.1",
    },
  ])("parses %s", ({ spec, expected }) => {
    expect(parseRegistryNpmSpec(spec)).toEqual(expected);
  });

  it.each([
    { expected: true, value: "v1.2.3" },
    { expected: false, value: "1.2" },
  ])("detects exact semver versions for %s", ({ value, expected }) => {
    expect(isExactSemverVersion(value)).toBe(expected);
  });

  it.each([
    { expected: true, value: "1.2.3-beta.1" },
    { expected: false, value: "1.2.3" },
  ])("detects prerelease semver versions for %s", ({ value, expected }) => {
    expect(isPrereleaseSemverVersion(value)).toBe(expected);
  });
});

describe("npm prerelease resolution policy", () => {
  it.each([
    {
      expected: false,
      resolvedVersion: "1.2.3-beta.1",
      spec: "@openclaw/voice-call",
    },
    {
      expected: false,
      resolvedVersion: "1.2.3-rc.1",
      spec: "@openclaw/voice-call@latest",
    },
    {
      expected: true,
      resolvedVersion: "1.2.3-beta.4",
      spec: "@openclaw/voice-call@beta",
    },
    {
      expected: true,
      resolvedVersion: "1.2.3-beta.1",
      spec: "@openclaw/voice-call@1.2.3-beta.1",
    },
    {
      expected: true,
      resolvedVersion: "1.2.3",
      spec: "@openclaw/voice-call",
    },
    {
      expected: true,
      resolvedVersion: undefined,
      spec: "@openclaw/voice-call@latest",
    },
  ])("decides prerelease resolution for %s -> %s", ({ spec, resolvedVersion, expected }) => {
    expect(
      isPrereleaseResolutionAllowed({
        resolvedVersion,
        spec: parseSpecOrThrow(spec),
      }),
    ).toBe(expected);
  });

  it.each([
    {
      expected: `Use "@openclaw/voice-call@beta"`,
      resolvedVersion: "1.2.3-beta.1",
      spec: "@openclaw/voice-call",
    },
    {
      expected: "Use an explicit prerelease tag or exact prerelease version",
      resolvedVersion: "1.2.3-rc.1",
      spec: "@openclaw/voice-call@beta",
    },
  ])("formats prerelease guidance for %s", ({ spec, resolvedVersion, expected }) => {
    expect(
      formatPrereleaseResolutionError({
        resolvedVersion,
        spec: parseSpecOrThrow(spec),
      }),
    ).toContain(expected);
  });
});
