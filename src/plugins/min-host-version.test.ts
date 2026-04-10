import { describe, expect, it } from "vitest";
import {
  MIN_HOST_VERSION_FORMAT,
  checkMinHostVersion,
  parseMinHostVersionRequirement,
  validateMinHostVersion,
} from "./min-host-version.js";

const MIN_HOST_REQUIREMENT = {
  minimumLabel: "2026.3.22",
  raw: ">=2026.3.22",
};

function expectValidHostCheck(currentVersion: string, minHostVersion?: string) {
  expectHostCheckResult({
    currentVersion,
    expected: {
      ok: true,
      requirement: minHostVersion ? MIN_HOST_REQUIREMENT : null,
    },
    minHostVersion,
  });
}

function expectHostCheckResult(params: {
  currentVersion: string;
  minHostVersion?: string | number;
  expected: unknown;
}) {
  expect(
    checkMinHostVersion({
      currentVersion: params.currentVersion,
      minHostVersion: params.minHostVersion,
    }),
  ).toEqual(params.expected);
}

function expectInvalidMinHostVersion(minHostVersion: string | number) {
  expect(validateMinHostVersion(minHostVersion)).toBe(MIN_HOST_VERSION_FORMAT);
  expectHostCheckResult({
    currentVersion: "2026.3.22",
    expected: {
      error: MIN_HOST_VERSION_FORMAT,
      kind: "invalid",
      ok: false,
    },
    minHostVersion,
  });
}

describe("min-host-version", () => {
  it("accepts empty metadata", () => {
    expect(validateMinHostVersion(undefined)).toBeNull();
    expect(parseMinHostVersionRequirement(undefined)).toBeNull();
    expectValidHostCheck("2026.3.22");
  });

  it("parses semver floors", () => {
    expect(parseMinHostVersionRequirement(">=2026.3.22")).toEqual(MIN_HOST_REQUIREMENT);
  });

  it.each(["2026.3.22", 123, ">=2026.3.22 garbage"] as const)(
    "rejects invalid floor syntax and host checks: %p",
    (minHostVersion) => {
      expectInvalidMinHostVersion(minHostVersion);
    },
  );

  it.each([
    {
      currentVersion: "unknown",
      expected: {
        kind: "unknown_host_version",
        ok: false,
        requirement: MIN_HOST_REQUIREMENT,
      },
      name: "reports unknown host versions distinctly",
    },
    {
      currentVersion: "2026.3.21",
      expected: {
        currentVersion: "2026.3.21",
        kind: "incompatible",
        ok: false,
        requirement: MIN_HOST_REQUIREMENT,
      },
      name: "reports incompatible hosts",
    },
  ] as const)("$name", ({ currentVersion, expected }) => {
    expectHostCheckResult({
      currentVersion,
      expected,
      minHostVersion: ">=2026.3.22",
    });
  });

  it.each(["2026.3.22", "2026.4.0"] as const)(
    "accepts equal or newer hosts: %s",
    (currentVersion) => {
      expectValidHostCheck(currentVersion, ">=2026.3.22");
    },
  );
});
