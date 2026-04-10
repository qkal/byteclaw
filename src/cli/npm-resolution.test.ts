import { describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import {
  buildNpmInstallRecordFields,
  logPinnedNpmSpecMessages,
  mapNpmResolutionMetadata,
  resolvePinnedNpmInstallRecord,
  resolvePinnedNpmInstallRecordForCli,
  resolvePinnedNpmSpec,
} from "./npm-resolution.js";

const CLI_STATE_ROOT = "/tmp/openclaw";
const ALPHA_INSTALL_PATH = installedPluginRoot(CLI_STATE_ROOT, "alpha");

describe("npm-resolution helpers", () => {
  it("keeps original spec when pin is disabled", () => {
    const result = resolvePinnedNpmSpec({
      pin: false,
      rawSpec: "@openclaw/plugin-alpha@latest",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
    });
    expect(result).toEqual({
      recordSpec: "@openclaw/plugin-alpha@latest",
    });
  });

  it("warns when pin is enabled but resolved spec is missing", () => {
    const result = resolvePinnedNpmSpec({
      pin: true,
      rawSpec: "@openclaw/plugin-alpha@latest",
    });
    expect(result).toEqual({
      pinWarning: "Could not resolve exact npm version for --pin; storing original npm spec.",
      recordSpec: "@openclaw/plugin-alpha@latest",
    });
  });

  it("returns pinned spec notice when resolved spec is available", () => {
    const result = resolvePinnedNpmSpec({
      pin: true,
      rawSpec: "@openclaw/plugin-alpha@latest",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
    });
    expect(result).toEqual({
      pinNotice: "Pinned npm install record to @openclaw/plugin-alpha@1.2.3.",
      recordSpec: "@openclaw/plugin-alpha@1.2.3",
    });
  });

  it("maps npm resolution metadata to install fields", () => {
    expect(
      mapNpmResolutionMetadata({
        integrity: "sha512-abc",
        name: "@openclaw/plugin-alpha",
        resolvedAt: "2026-02-21T00:00:00.000Z",
        resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
        shasum: "deadbeef",
        version: "1.2.3",
      }),
    ).toEqual({
      integrity: "sha512-abc",
      resolvedAt: "2026-02-21T00:00:00.000Z",
      resolvedName: "@openclaw/plugin-alpha",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
      resolvedVersion: "1.2.3",
      shasum: "deadbeef",
    });
  });

  it("builds common npm install record fields", () => {
    expect(
      buildNpmInstallRecordFields({
        installPath: ALPHA_INSTALL_PATH,
        resolution: {
          integrity: "sha512-abc",
          name: "@openclaw/plugin-alpha",
          resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
          version: "1.2.3",
        },
        spec: "@openclaw/plugin-alpha@1.2.3",
        version: "1.2.3",
      }),
    ).toEqual({
      installPath: ALPHA_INSTALL_PATH,
      integrity: "sha512-abc",
      resolvedAt: undefined,
      resolvedName: "@openclaw/plugin-alpha",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
      resolvedVersion: "1.2.3",
      shasum: undefined,
      source: "npm",
      spec: "@openclaw/plugin-alpha@1.2.3",
      version: "1.2.3",
    });
  });

  it("logs pin warning/notice messages through provided writers", () => {
    const logs: string[] = [];
    const warns: string[] = [];
    logPinnedNpmSpecMessages(
      {
        pinNotice: "notice-1",
        pinWarning: "warn-1",
      },
      (message) => logs.push(message),
      (message) => warns.push(message),
    );

    expect(logs).toEqual(["notice-1"]);
    expect(warns).toEqual(["warn-1"]);
  });

  it("resolves pinned install record and emits pin notice", () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const record = resolvePinnedNpmInstallRecord({
      installPath: ALPHA_INSTALL_PATH,
      log: (message) => logs.push(message),
      pin: true,
      rawSpec: "@openclaw/plugin-alpha@latest",
      resolution: {
        name: "@openclaw/plugin-alpha",
        resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
        version: "1.2.3",
      },
      version: "1.2.3",
      warn: (message) => warns.push(message),
    });

    expect(record).toEqual({
      installPath: ALPHA_INSTALL_PATH,
      integrity: undefined,
      resolvedAt: undefined,
      resolvedName: "@openclaw/plugin-alpha",
      resolvedSpec: "@openclaw/plugin-alpha@1.2.3",
      resolvedVersion: "1.2.3",
      shasum: undefined,
      source: "npm",
      spec: "@openclaw/plugin-alpha@1.2.3",
      version: "1.2.3",
    });
    expect(logs).toEqual(["Pinned npm install record to @openclaw/plugin-alpha@1.2.3."]);
    expect(warns).toEqual([]);
  });

  it("resolves pinned install record for CLI and formats warning output", () => {
    const logs: string[] = [];
    const record = resolvePinnedNpmInstallRecordForCli(
      "@openclaw/plugin-alpha@latest",
      true,
      ALPHA_INSTALL_PATH,
      "1.2.3",
      undefined,
      (message) => logs.push(message),
      (message) => `[warn] ${message}`,
    );

    expect(record).toEqual({
      installPath: ALPHA_INSTALL_PATH,
      integrity: undefined,
      resolvedAt: undefined,
      resolvedName: undefined,
      resolvedSpec: undefined,
      resolvedVersion: undefined,
      shasum: undefined,
      source: "npm",
      spec: "@openclaw/plugin-alpha@latest",
      version: "1.2.3",
    });
    expect(logs).toEqual([
      "[warn] Could not resolve exact npm version for --pin; storing original npm spec.",
    ]);
  });
});
