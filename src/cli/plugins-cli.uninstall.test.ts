import { beforeEach, describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildPluginDiagnosticsReport,
  loadConfig,
  parseClawHubPluginSpec,
  promptYesNo,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  uninstallPlugin,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";
const ALPHA_INSTALL_PATH = installedPluginRoot(CLI_STATE_ROOT, "alpha");

describe("plugins cli uninstall", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("shows uninstall dry-run preview without mutating config", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
        installs: {
          alpha: {
            installPath: ALPHA_INSTALL_PATH,
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
          },
        },
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "alpha", name: "alpha" }],
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runtimeLogs.some((line) => line.includes("Dry run, no changes made."))).toBe(true);
  });

  it("uninstalls with --force and --keep-files without prompting", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: {
          alpha: {
            installPath: ALPHA_INSTALL_PATH,
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "alpha", name: "alpha" }],
    });
    uninstallPlugin.mockResolvedValue({
      actions: {
        allowlist: false,
        directory: false,
        entry: true,
        install: true,
        loadPath: false,
        memorySlot: false,
      },
      config: nextConfig,
      ok: true,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expect(promptYesNo).not.toHaveBeenCalled();
    expect(uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        deleteFiles: false,
        pluginId: "alpha",
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
  });

  it("exits when uninstall target is not managed by plugin install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "alpha", name: "alpha" }],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not managed by plugins config/install records");
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("accepts the recorded ClawHub spec as an uninstall target", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "linkmind-context": { enabled: true },
        },
        installs: {
          "linkmind-context": {
            clawhubPackage: "linkmind-context",
            source: "npm",
            spec: "clawhub:linkmind-context",
          },
        },
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "linkmind-context", name: "linkmind-context" }],
    });
    parseClawHubPluginSpec.mockImplementation((raw: string) =>
      raw === "clawhub:linkmind-context" ? { name: "linkmind-context" } : null,
    );

    await runPluginsCommand(["plugins", "uninstall", "clawhub:linkmind-context", "--force"]);

    expect(uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "linkmind-context",
      }),
    );
  });

  it("accepts a versionless ClawHub spec when the install was pinned", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          "linkmind-context": { enabled: true },
        },
        installs: {
          "linkmind-context": {
            source: "npm",
            spec: "clawhub:linkmind-context@1.2.3",
          },
        },
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "linkmind-context", name: "linkmind-context" }],
    });
    parseClawHubPluginSpec.mockImplementation((raw: string) => {
      if (raw === "clawhub:linkmind-context") {
        return { name: "linkmind-context" };
      }
      if (raw === "clawhub:linkmind-context@1.2.3") {
        return { name: "linkmind-context", version: "1.2.3" };
      }
      return null;
    });

    await runPluginsCommand(["plugins", "uninstall", "clawhub:linkmind-context", "--force"]);

    expect(uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "linkmind-context",
      }),
    );
  });
});
