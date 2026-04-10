import { describe, expect, it } from "vitest";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";

function expectRecordedInstall(pluginId: string, next: ReturnType<typeof recordPluginInstall>) {
  expect(next.plugins?.installs?.[pluginId]).toMatchObject({
    source: "npm",
    spec: `${pluginId}@latest`,
  });
  expect(typeof next.plugins?.installs?.[pluginId]?.installedAt).toBe("string");
}

function createExpectedResolutionFields(
  overrides: Partial<ReturnType<typeof buildNpmResolutionInstallFields>>,
) {
  return {
    integrity: undefined,
    resolvedAt: undefined,
    resolvedName: undefined,
    resolvedSpec: undefined,
    resolvedVersion: undefined,
    shasum: undefined,
    ...overrides,
  };
}

function expectResolutionFieldsCase(params: {
  input: Parameters<typeof buildNpmResolutionInstallFields>[0];
  expected: ReturnType<typeof buildNpmResolutionInstallFields>;
}) {
  expect(buildNpmResolutionInstallFields(params.input)).toEqual(params.expected);
}

describe("buildNpmResolutionInstallFields", () => {
  it.each([
    {
      expected: createExpectedResolutionFields({
        integrity: "sha512-abc",
        resolvedAt: "2026-02-22T00:00:00.000Z",
        resolvedName: "@openclaw/demo",
        resolvedSpec: "@openclaw/demo@1.2.3",
        resolvedVersion: "1.2.3",
        shasum: "deadbeef",
      }),
      input: {
        integrity: "sha512-abc",
        name: "@openclaw/demo",
        resolvedAt: "2026-02-22T00:00:00.000Z",
        resolvedSpec: "@openclaw/demo@1.2.3",
        shasum: "deadbeef",
        version: "1.2.3",
      },
      name: "maps npm resolution metadata into install record fields",
    },
    {
      expected: createExpectedResolutionFields({}),
      input: undefined,
      name: "returns undefined fields when resolution is missing",
    },
    {
      expected: createExpectedResolutionFields({
        resolvedName: "@openclaw/demo",
      }),
      input: {
        name: "@openclaw/demo",
      },
      name: "keeps missing partial resolution fields undefined",
    },
  ] as const)("$name", expectResolutionFieldsCase);
});

describe("recordPluginInstall", () => {
  it("stores install metadata for the plugin id", () => {
    const next = recordPluginInstall({}, { pluginId: "demo", source: "npm", spec: "demo@latest" });
    expectRecordedInstall("demo", next);
  });
});
