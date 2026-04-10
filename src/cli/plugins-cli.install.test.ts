import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  buildPluginDiagnosticsReport,
  clearPluginManifestRegistryCache,
  enablePluginInConfig,
  installHooksFromNpmSpec,
  installHooksFromPath,
  installPluginFromClawHub,
  installPluginFromMarketplace,
  installPluginFromNpmSpec,
  installPluginFromPath,
  loadConfig,
  parseClawHubPluginSpec,
  readConfigFileSnapshot,
  recordHookInstall,
  recordPluginInstall,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";

function cliInstallPath(pluginId: string): string {
  return installedPluginRoot(CLI_STATE_ROOT, pluginId);
}

function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

function createEmptyPluginConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {},
    },
  } as OpenClawConfig;
}

function createClawHubInstalledConfig(params: {
  pluginId: string;
  install: Record<string, unknown>;
}): OpenClawConfig {
  const enabledCfg = createEnabledPluginConfig(params.pluginId);
  return {
    ...enabledCfg,
    plugins: {
      ...enabledCfg.plugins,
      installs: {
        [params.pluginId]: params.install,
      },
    },
  } as OpenClawConfig;
}

function createClawHubInstallResult(params: {
  pluginId: string;
  packageName: string;
  version: string;
  channel: string;
}): Awaited<ReturnType<typeof installPluginFromClawHub>> {
  return {
    clawhub: {
      clawhubChannel: params.channel,
      clawhubFamily: "code-plugin",
      clawhubPackage: params.packageName,
      clawhubUrl: "https://clawhub.ai",
      integrity: "sha256-abc",
      resolvedAt: "2026-03-22T00:00:00.000Z",
      source: "clawhub",
      version: params.version,
    },
    ok: true,
    packageName: params.packageName,
    pluginId: params.pluginId,
    targetDir: cliInstallPath(params.pluginId),
    version: params.version,
  };
}

function createNpmPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromNpmSpec>> {
  return {
    npmResolution: {
      packageName: pluginId,
      resolvedVersion: "1.2.3",
      tarballUrl: `https://registry.npmjs.org/${pluginId}/-/${pluginId}-1.2.3.tgz`,
    },
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
  };
}

function mockClawHubPackageNotFound(packageName: string) {
  installPluginFromClawHub.mockResolvedValue({
    code: "package_not_found",
    error: `ClawHub /api/v1/packages/${packageName} failed (404): Package not found`,
    ok: false,
  });
}

function primeNpmPluginFallback(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg = createEnabledPluginConfig(pluginId);

  loadConfig.mockReturnValue(cfg);
  mockClawHubPackageNotFound(pluginId);
  installPluginFromNpmSpec.mockResolvedValue(createNpmPluginInstallResult(pluginId));
  enablePluginInConfig.mockReturnValue({ config: enabledCfg });
  recordPluginInstall.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelection.mockReturnValue({
    config: enabledCfg,
    warnings: [],
  });

  return { cfg, enabledCfg };
}

function createPathHookPackInstalledConfig(tmpRoot: string): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            installPath: tmpRoot,
            source: "path",
            sourcePath: tmpRoot,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createNpmHookPackInstalledConfig(): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "npm",
            spec: "@acme/demo-hooks@1.2.3",
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createHookPackInstallResult(targetDir: string): {
  ok: true;
  hookPackId: string;
  hooks: string[];
  targetDir: string;
  version: string;
} {
  return {
    hookPackId: "demo-hooks",
    hooks: ["command-audit"],
    ok: true,
    targetDir,
    version: "1.2.3",
  };
}

function primeHookPackNpmFallback() {
  const cfg = {} as OpenClawConfig;
  const installedCfg = createNpmHookPackInstalledConfig();

  loadConfig.mockReturnValue(cfg);
  mockClawHubPackageNotFound("@acme/demo-hooks");
  installPluginFromNpmSpec.mockResolvedValue({
    error: "package.json missing openclaw.plugin.json",
    ok: false,
  });
  installHooksFromNpmSpec.mockResolvedValue({
    ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
    npmResolution: {
      integrity: "sha256-demo",
      name: "@acme/demo-hooks",
      spec: "@acme/demo-hooks@1.2.3",
    },
  });
  recordHookInstall.mockReturnValue(installedCfg);

  return { cfg, installedCfg };
}

function primeHookPackPathFallback(params: {
  tmpRoot: string;
  pluginInstallError: string;
}): OpenClawConfig {
  const installedCfg = createPathHookPackInstalledConfig(params.tmpRoot);

  loadConfig.mockReturnValue({} as OpenClawConfig);
  installPluginFromPath.mockResolvedValueOnce({
    error: params.pluginInstallError,
    ok: false,
  });
  installHooksFromPath.mockResolvedValueOnce(createHookPackInstallResult(params.tmpRoot));
  recordHookInstall.mockReturnValue(installedCfg);

  return installedCfg;
}

describe("plugins cli install", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("shows the force overwrite option in install help", async () => {
    const { Command } = await import("commander");
    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const installCommand = pluginsCommand?.commands.find((command) => command.name() === "install");
    const helpText = installCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--force");
    expect(helpText).toContain("Overwrite an existing installed plugin or");
    expect(helpText).toContain("hook pack");
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--link"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--link` is not supported with `--marketplace`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
  });

  it("exits when --force is combined with --link", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "./plugin", "--link", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("`--force` is not supported with `--link`.");
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfig.mockImplementation(() => {
      throw invalidConfigErr;
    });
    readConfigFileSnapshot.mockResolvedValue({
      config: { models: { default: 123 } },
      exists: true,
      hash: "mock",
      issues: [{ message: "invalid model ref", path: "models.default" }],
      legacyIssues: [],
      parsed: { models: { default: 123 } },
      path: "/tmp/openclaw-config.json5",
      raw: '{ "models": { "default": 123 } }',
      resolved: { models: { default: 123 } },
      valid: false,
      warnings: [],
    });

    await expect(runPluginsCommand(["plugins", "install", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expect(installPluginFromMarketplace).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("installs marketplace plugins and persists config", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = {
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    const installedCfg = {
      ...enabledCfg,
      plugins: {
        ...enabledCfg.plugins,
        installs: {
          alpha: {
            installPath: cliInstallPath("alpha"),
            source: "marketplace",
          },
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(cfg);
    installPluginFromMarketplace.mockResolvedValue({
      extensions: ["index.js"],
      marketplaceName: "Claude",
      marketplacePlugin: "alpha",
      marketplaceSource: "local/repo",
      ok: true,
      pluginId: "alpha",
      targetDir: cliInstallPath("alpha"),
      version: "1.2.3",
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    buildPluginDiagnosticsReport.mockReturnValue({
      diagnostics: [],
      plugins: [{ id: "alpha", kind: "provider" }],
    });
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: ["slot adjusted"],
    });

    await runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo"]);

    expect(clearPluginManifestRegistryCache).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("slot adjusted"))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: alpha"))).toBe(true);
  });

  it("passes force through as overwrite mode for marketplace installs", async () => {
    await expect(
      runPluginsCommand(["plugins", "install", "alpha", "--marketplace", "local/repo", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "local/repo",
        mode: "update",
        plugin: "alpha",
      }),
    );
  });

  it("installs ClawHub plugins and persists source metadata", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const installedCfg = createClawHubInstalledConfig({
      install: {
        clawhubChannel: "official",
        clawhubFamily: "code-plugin",
        clawhubPackage: "demo",
        installPath: cliInstallPath("demo"),
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
      },
      pluginId: "demo",
    });

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        channel: "official",
        packageName: "demo",
        pluginId: "demo",
        version: "1.2.3",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(recordPluginInstall).toHaveBeenCalledWith(
      enabledCfg,
      expect.objectContaining({
        clawhubChannel: "official",
        clawhubFamily: "code-plugin",
        clawhubPackage: "demo",
        pluginId: "demo",
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed plugin: demo"))).toBe(true);
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it("passes force through as overwrite mode for ClawHub installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    loadConfig.mockReturnValue(cfg);
    parseClawHubPluginSpec.mockReturnValue({ name: "demo" });
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        channel: "official",
        packageName: "demo",
        pluginId: "demo",
        version: "1.2.3",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "clawhub:demo", "--force"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        spec: "clawhub:demo",
      }),
    );
  });

  it("prefers ClawHub before npm for bare plugin specs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const installedCfg = createClawHubInstalledConfig({
      install: {
        clawhubPackage: "demo",
        installPath: cliInstallPath("demo"),
        source: "clawhub",
        spec: "clawhub:demo@1.2.3",
      },
      pluginId: "demo",
    });

    loadConfig.mockReturnValue(cfg);
    installPluginFromClawHub.mockResolvedValue(
      createClawHubInstallResult({
        channel: "community",
        packageName: "demo",
        pluginId: "demo",
        version: "1.2.3",
      }),
    );
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(installedCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: installedCfg,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
  });

  it("falls back to npm when ClawHub does not have the package", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHub).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:demo",
      }),
    );
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "demo",
      }),
    );
  });

  it("passes dangerous force unsafe install to marketplace installs", async () => {
    await expect(
      runPluginsCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--dangerously-force-unsafe-install",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslyForceUnsafeInstall: true,
        marketplace: "local/repo",
        plugin: "alpha",
      }),
    );
  });

  it("passes dangerous force unsafe install to npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--dangerously-force-unsafe-install"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslyForceUnsafeInstall: true,
        spec: "demo",
      }),
    );
  });

  it("passes dangerous force unsafe install to linked path probe installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-link-"));

    loadConfig.mockReturnValue(cfg);
    installPluginFromPath.mockResolvedValueOnce({
      extensions: ["./dist/index.js"],
      ok: true,
      pluginId: "demo",
      targetDir: tmpRoot,
      version: "1.2.3",
    });
    enablePluginInConfig.mockReturnValue({ config: enabledCfg });
    recordPluginInstall.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { force: true, recursive: true });
    }

    expect(installPluginFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslyForceUnsafeInstall: true,
        dryRun: true,
        path: tmpRoot,
      }),
    );
  });

  it("passes dangerous force unsafe install to linked hook-pack probe fallback", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-link-"));
    primeHookPackPathFallback({
      pluginInstallError: "plugin install probe failed",
      tmpRoot,
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { force: true, recursive: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslyForceUnsafeInstall: true,
        dryRun: true,
        path: tmpRoot,
      }),
    );
  });

  it("passes dangerous force unsafe install to local hook-pack fallback installs", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-install-"));
    primeHookPackPathFallback({
      pluginInstallError: "plugin install failed",
      tmpRoot,
    });

    try {
      await runPluginsCommand([
        "plugins",
        "install",
        tmpRoot,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { force: true, recursive: true });
    }

    expect(installHooksFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslyForceUnsafeInstall: true,
        mode: "install",
        path: tmpRoot,
      }),
    );
  });
  it("passes force through as overwrite mode for npm installs", async () => {
    primeNpmPluginFallback();

    await runPluginsCommand(["plugins", "install", "demo", "--force"]);

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        spec: "demo",
      }),
    );
  });

  it("does not fall back to npm when ClawHub rejects a real package", async () => {
    installPluginFromClawHub.mockResolvedValue({
      code: "skill_package",
      error: 'Use "openclaw skills install demo" instead.',
      ok: false,
    });

    await expect(runPluginsCommand(["plugins", "install", "demo"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Use "openclaw skills install demo" instead.');
  });

  it("falls back to installing hook packs from npm specs", async () => {
    const { installedCfg } = primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "@acme/demo-hooks",
      }),
    );
    expect(recordHookInstall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hookId: "demo-hooks",
        hooks: ["command-audit"],
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogs.some((line) => line.includes("Installed hook pack: demo-hooks"))).toBe(true);
  });

  it("passes force through as overwrite mode for hook-pack npm fallback installs", async () => {
    primeHookPackNpmFallback();

    await runPluginsCommand(["plugins", "install", "@acme/demo-hooks", "--force"]);

    expect(installHooksFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "update",
        spec: "@acme/demo-hooks",
      }),
    );
  });
});
