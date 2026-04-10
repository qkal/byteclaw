import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS,
  listMissingExternalCodePluginFieldPaths,
  normalizeExternalPluginCompatibility,
  validateExternalCodePluginPackageJson,
} from "./index.js";

describe("@openclaw/plugin-package-contract", () => {
  it("normalizes the OpenClaw compatibility block for external plugins", () => {
    expect(
      normalizeExternalPluginCompatibility({
        openclaw: {
          build: {
            openclawVersion: "2026.3.24-beta.2",
            pluginSdkVersion: "0.9.0",
          },
          compat: {
            minGatewayVersion: "2026.3.24-beta.2",
            pluginApi: ">=2026.3.24-beta.2",
          },
        },
        version: "1.2.3",
      }),
    ).toEqual({
      builtWithOpenClawVersion: "2026.3.24-beta.2",
      minGatewayVersion: "2026.3.24-beta.2",
      pluginApiRange: ">=2026.3.24-beta.2",
      pluginSdkVersion: "0.9.0",
    });
  });

  it("falls back to install.minHostVersion and package version when compatible", () => {
    expect(
      normalizeExternalPluginCompatibility({
        openclaw: {
          compat: {
            pluginApi: ">=1.0.0",
          },
          install: {
            minHostVersion: "2026.3.24-beta.2",
          },
        },
        version: "1.2.3",
      }),
    ).toEqual({
      builtWithOpenClawVersion: "1.2.3",
      minGatewayVersion: "2026.3.24-beta.2",
      pluginApiRange: ">=1.0.0",
    });
  });

  it("lists the required external code-plugin fields", () => {
    expect(EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS).toEqual([
      "openclaw.compat.pluginApi",
      "openclaw.build.openclawVersion",
    ]);
  });

  it("reports missing required fields with stable field paths", () => {
    const packageJson = {
      openclaw: {
        build: {},
        compat: {},
      },
    };

    expect(listMissingExternalCodePluginFieldPaths(packageJson)).toEqual([
      "openclaw.compat.pluginApi",
      "openclaw.build.openclawVersion",
    ]);
    expect(validateExternalCodePluginPackageJson(packageJson).issues).toEqual([
      {
        fieldPath: "openclaw.compat.pluginApi",
        message:
          "openclaw.compat.pluginApi is required for external code plugins published to ClawHub.",
      },
      {
        fieldPath: "openclaw.build.openclawVersion",
        message:
          "openclaw.build.openclawVersion is required for external code plugins published to ClawHub.",
      },
    ]);
  });
});
