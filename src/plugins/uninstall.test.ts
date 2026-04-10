import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginInstallDir } from "./install.js";
import {
  cleanupTrackedTempDirsAsync,
  makeTrackedTempDirAsync,
} from "./test-helpers/fs-fixtures.js";
import {
  removePluginFromConfig,
  resolveUninstallChannelConfigKeys,
  resolveUninstallDirectoryTarget,
  uninstallPlugin,
} from "./uninstall.js";

type PluginConfig = NonNullable<OpenClawConfig["plugins"]>;
type PluginInstallRecord = NonNullable<PluginConfig["installs"]>[string];

async function createInstalledNpmPluginFixture(params: {
  baseDir: string;
  pluginId?: string;
}): Promise<{
  pluginId: string;
  extensionsDir: string;
  pluginDir: string;
  config: OpenClawConfig;
}> {
  const pluginId = params.pluginId ?? "my-plugin";
  const extensionsDir = path.join(params.baseDir, "extensions");
  const pluginDir = resolvePluginInstallDir(pluginId, extensionsDir);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");

  return {
    config: {
      plugins: {
        entries: {
          [pluginId]: { enabled: true },
        },
        installs: {
          [pluginId]: {
            installPath: pluginDir,
            source: "npm",
            spec: `${pluginId}@1.0.0`,
          },
        },
      },
    },
    extensionsDir,
    pluginDir,
    pluginId,
  };
}

type UninstallResult = Awaited<ReturnType<typeof uninstallPlugin>>;

async function runDeleteInstalledNpmPluginFixture(baseDir: string): Promise<{
  pluginDir: string;
  result: UninstallResult;
}> {
  const { pluginId, extensionsDir, pluginDir, config } = await createInstalledNpmPluginFixture({
    baseDir,
  });
  const result = await uninstallPlugin({
    config,
    deleteFiles: true,
    extensionsDir,
    pluginId,
  });
  return { pluginDir, result };
}

function expectSuccessfulUninstall(result: UninstallResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected uninstall success, got: ${result.error}`);
  }
  return result;
}

function expectSuccessfulUninstallActions(
  result: UninstallResult,
  params: {
    directory: boolean;
    loadPath?: boolean;
    warnings?: string[];
  },
) {
  const successfulResult = expectSuccessfulUninstall(result);
  expect(successfulResult.actions.directory).toBe(params.directory);
  if (params.loadPath !== undefined) {
    expect(successfulResult.actions.loadPath).toBe(params.loadPath);
  }
  if (params.warnings) {
    expect(successfulResult.warnings).toEqual(params.warnings);
  }
  return successfulResult;
}

function createSinglePluginEntries(pluginId = "my-plugin") {
  return {
    [pluginId]: { enabled: true },
  };
}

function createNpmInstallRecord(pluginId = "my-plugin", installPath?: string): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${pluginId}@1.0.0`,
    ...(installPath ? { installPath } : {}),
  };
}

function createPathInstallRecord(
  installPath = "/path/to/plugin",
  sourcePath = installPath,
): PluginInstallRecord {
  return {
    installPath,
    source: "path",
    sourcePath,
  };
}

function createPluginConfig(params: {
  entries?: Record<string, { enabled: boolean }>;
  installs?: Record<string, PluginInstallRecord>;
  allow?: string[];
  deny?: string[];
  enabled?: boolean;
  slots?: PluginConfig["slots"];
  loadPaths?: string[];
  channels?: OpenClawConfig["channels"];
}): OpenClawConfig {
  const plugins: PluginConfig = {};
  if (params.entries) {
    plugins.entries = params.entries;
  }
  if (params.installs) {
    plugins.installs = params.installs;
  }
  if (params.allow) {
    plugins.allow = params.allow;
  }
  if (params.deny) {
    plugins.deny = params.deny;
  }
  if (params.enabled !== undefined) {
    plugins.enabled = params.enabled;
  }
  if (params.slots) {
    plugins.slots = params.slots;
  }
  if (params.loadPaths) {
    plugins.load = { paths: params.loadPaths };
  }
  return {
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
    ...(params.channels ? { channels: params.channels } : {}),
  };
}

function expectRemainingChannels(
  channels: OpenClawConfig["channels"],
  expected: Record<string, unknown> | undefined,
) {
  expect(channels as Record<string, unknown> | undefined).toEqual(expected);
}

function expectChannelCleanupResult(params: {
  config: OpenClawConfig;
  pluginId: string;
  expectedChannels: Record<string, unknown> | undefined;
  expectedChanged: boolean;
  options?: { channelIds?: readonly string[] };
}) {
  const { config: result, actions } = removePluginFromConfig(
    params.config,
    params.pluginId,
    params.options
      ? (params.options.channelIds
        ? { channelIds: [...params.options.channelIds] }
        : {})
      : undefined,
  );
  expectRemainingChannels(result.channels, params.expectedChannels);
  expect(actions.channelConfig).toBe(params.expectedChanged);
}

function createSinglePluginWithEmptySlotsConfig(): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    slots: {},
  });
}

function createSingleNpmInstallConfig(installPath: string): OpenClawConfig {
  return createPluginConfig({
    entries: createSinglePluginEntries(),
    installs: {
      "my-plugin": createNpmInstallRecord("my-plugin", installPath),
    },
  });
}

async function createPluginDirFixture(baseDir: string, pluginId = "my-plugin") {
  const pluginDir = path.join(baseDir, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.js"), "// plugin");
  return pluginDir;
}

async function expectPathAccessState(pathToCheck: string, expected: "exists" | "missing") {
  const accessExpectation = fs.access(pathToCheck);
  if (expected === "exists") {
    await expect(accessExpectation).resolves.toBeUndefined();
    return;
  }
  await expect(accessExpectation).rejects.toThrow();
}

describe("resolveUninstallChannelConfigKeys", () => {
  it("falls back to pluginId when channelIds are unknown", () => {
    expect(resolveUninstallChannelConfigKeys("timbot")).toEqual(["timbot"]);
  });

  it("keeps explicit empty channelIds as remove-nothing", () => {
    expect(resolveUninstallChannelConfigKeys("telegram", { channelIds: [] })).toEqual([]);
  });

  it("filters shared keys and duplicate channel ids", () => {
    expect(
      resolveUninstallChannelConfigKeys("bad-plugin", {
        channelIds: ["defaults", "discord", "discord", "modelByChannel", "slack"],
      }),
    ).toEqual(["discord", "slack"]);
  });
});

describe("removePluginFromConfig", () => {
  it("removes plugin from entries", () => {
    const config = createPluginConfig({
      entries: {
        ...createSinglePluginEntries(),
        "other-plugin": { enabled: true },
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual({ "other-plugin": { enabled: true } });
    expect(actions.entry).toBe(true);
  });

  it("removes plugin from installs", () => {
    const config = createPluginConfig({
      installs: {
        "my-plugin": createNpmInstallRecord(),
        "other-plugin": createNpmInstallRecord("other-plugin"),
      },
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.installs).toEqual({
      "other-plugin": createNpmInstallRecord("other-plugin"),
    });
    expect(actions.install).toBe(true);
  });

  it("removes plugin from allowlist", () => {
    const config = createPluginConfig({
      allow: ["my-plugin", "other-plugin"],
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.allow).toEqual(["other-plugin"]);
    expect(actions.allowlist).toBe(true);
  });

  it.each([
    {
      expectedPaths: ["/other/path"],
      loadPaths: ["/path/to/plugin", "/other/path"],
      name: "removes linked path from load.paths",
    },
    {
      expectedPaths: undefined,
      loadPaths: ["/path/to/plugin"],
      name: "cleans up load when removing the only linked path",
    },
  ])("$name", ({ loadPaths, expectedPaths }) => {
    const config = createPluginConfig({
      installs: {
        "my-plugin": createPathInstallRecord(),
      },
      loadPaths,
    });

    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.load?.paths).toEqual(expectedPaths);
    expect(actions.loadPath).toBe(true);
  });

  it.each([
    {
      config: createPluginConfig({
        entries: {
          "memory-plugin": { enabled: true },
        },
        slots: {
          memory: "memory-plugin",
        },
      }),
      expectedChanged: true,
      expectedMemory: "memory-core",
      name: "clears memory slot when uninstalling active memory plugin",
      pluginId: "memory-plugin",
    },
    {
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        slots: {
          memory: "memory-core",
        },
      }),
      expectedChanged: false,
      expectedMemory: "memory-core",
      name: "does not modify memory slot when uninstalling non-memory plugin",
      pluginId: "my-plugin",
    },
  ] as const)("$name", ({ config, pluginId, expectedMemory, expectedChanged }) => {
    const { config: result, actions } = removePluginFromConfig(config, pluginId);

    expect(result.plugins?.slots?.memory).toBe(expectedMemory);
    expect(actions.memorySlot).toBe(expectedChanged);
  });

  it("removes plugins object when uninstall leaves only empty slots", () => {
    const config = createSinglePluginWithEmptySlotsConfig();

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.slots).toBeUndefined();
  });

  it("cleans up empty slots object", () => {
    const config = createSinglePluginWithEmptySlotsConfig();

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins).toBeUndefined();
  });

  it.each([
    {
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
      }),
      entryChanged: true,
      expectedEntries: undefined,
      expectedInstalls: undefined,
      installChanged: false,
      name: "handles plugin that only exists in entries",
    },
    {
      config: createPluginConfig({
        installs: {
          "my-plugin": createNpmInstallRecord(),
        },
      }),
      entryChanged: false,
      expectedEntries: undefined,
      expectedInstalls: undefined,
      installChanged: true,
      name: "handles plugin that only exists in installs",
    },
  ])("$name", ({ config, expectedEntries, expectedInstalls, entryChanged, installChanged }) => {
    const { config: result, actions } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toEqual(expectedEntries);
    expect(result.plugins?.installs).toEqual(expectedInstalls);
    expect(actions.entry).toBe(entryChanged);
    expect(actions.install).toBe(installChanged);
  });

  it("cleans up empty plugins object", () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.entries).toBeUndefined();
  });

  it("preserves other config values", () => {
    const config = createPluginConfig({
      deny: ["denied-plugin"],
      enabled: true,
      entries: createSinglePluginEntries(),
    });

    const { config: result } = removePluginFromConfig(config, "my-plugin");

    expect(result.plugins?.enabled).toBe(true);
    expect(result.plugins?.deny).toEqual(["denied-plugin"]);
  });

  it.each([
    {
      config: createPluginConfig({
        channels: {
          telegram: { enabled: true },
          timbot: { sdkAppId: "123", secretKey: "abc" },
        },
        entries: {
          timbot: { enabled: true },
        },
        installs: {
          timbot: createNpmInstallRecord("timbot"),
        },
      }),
      expectedChanged: true,
      expectedChannels: {
        telegram: { enabled: true },
      },
      name: "removes channel config for installed extension plugin",
      pluginId: "timbot",
    },
    {
      config: createPluginConfig({
        channels: {
          discord: { enabled: true },
          telegram: { enabled: true },
        },
        entries: {
          telegram: { enabled: true },
        },
      }),
      expectedChanged: false,
      expectedChannels: {
        discord: { enabled: true },
        telegram: { enabled: true },
      },
      name: "does not remove channel config for built-in channel without install record",
      pluginId: "telegram",
    },
    {
      config: createPluginConfig({
        channels: {
          timbot: { sdkAppId: "123" },
        },
        entries: {
          timbot: { enabled: true },
        },
        installs: {
          timbot: createNpmInstallRecord("timbot"),
        },
      }),
      expectedChanged: true,
      expectedChannels: undefined,
      name: "cleans up channels object when removing the only channel config",
      pluginId: "timbot",
    },
    {
      config: createPluginConfig({
        entries: createSinglePluginEntries(),
        installs: {
          "my-plugin": createNpmInstallRecord(),
        },
      }),
      expectedChanged: false,
      expectedChannels: undefined,
      name: "does not set channelConfig action when no channel config exists",
      pluginId: "my-plugin",
    },
    {
      config: createPluginConfig({
        channels: {
          discord: { enabled: true, token: "abc" },
        },
        entries: {
          discord: { enabled: true },
        },
      }),
      expectedChanged: false,
      expectedChannels: {
        discord: {
          enabled: true,
          token: "abc",
        },
      },
      name: "does not remove channel config when plugin has no install record",
      pluginId: "discord",
    },
    {
      config: createPluginConfig({
        channels: {
          telegram: { enabled: true },
          timbot: { sdkAppId: "123" },
          "timbot-v2": { sdkAppId: "456" },
        },
        entries: {
          "timbot-plugin": { enabled: true },
        },
        installs: {
          "timbot-plugin": createNpmInstallRecord("timbot-plugin"),
        },
      }),
      expectedChanged: true,
      expectedChannels: {
        telegram: { enabled: true },
      },
      name: "removes channel config using explicit channelIds when pluginId differs",
      options: {
        channelIds: ["timbot", "timbot-v2"],
      },
      pluginId: "timbot-plugin",
    },
    {
      config: createPluginConfig({
        channels: {
          defaults: { groupPolicy: "opt-in" },
          modelByChannel: { timbot: "gpt-3.5" } as Record<string, string>,
          timbot: { sdkAppId: "123" },
        } as unknown as OpenClawConfig["channels"],
        entries: {
          timbot: { enabled: true },
        },
        installs: {
          timbot: createNpmInstallRecord("timbot"),
        },
      }),
      expectedChanged: true,
      expectedChannels: {
        defaults: { groupPolicy: "opt-in" },
        modelByChannel: { timbot: "gpt-3.5" },
      },
      name: "preserves shared channel keys (defaults, modelByChannel)",
      pluginId: "timbot",
    },
    {
      config: createPluginConfig({
        channels: {
          defaults: { groupPolicy: "opt-in" },
        } as unknown as OpenClawConfig["channels"],
        entries: {
          "bad-plugin": { enabled: true },
        },
        installs: {
          "bad-plugin": createNpmInstallRecord("bad-plugin"),
        },
      }),
      expectedChanged: false,
      expectedChannels: {
        defaults: { groupPolicy: "opt-in" },
      },
      name: "does not remove shared keys even when passed as channelIds",
      options: {
        channelIds: ["defaults"],
      },
      pluginId: "bad-plugin",
    },
    {
      config: createPluginConfig({
        channels: {
          telegram: { enabled: true },
        },
        entries: {
          telegram: { enabled: true },
        },
        installs: {
          telegram: createNpmInstallRecord("telegram"),
        },
      }),
      expectedChanged: false,
      expectedChannels: {
        telegram: { enabled: true },
      },
      name: "skips channel cleanup when channelIds is empty array (non-channel plugin)",
      options: {
        channelIds: [],
      },
      pluginId: "telegram",
    },
  ] as const)("$name", ({ config, pluginId, expectedChannels, expectedChanged, options }) => {
    expectChannelCleanupResult({
      config,
      expectedChanged,
      expectedChannels,
      options,
      pluginId,
    });
  });
});

describe("uninstallPlugin", () => {
  let tempDir: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    tempDir = await makeTrackedTempDirAsync("uninstall-test", tempDirs);
  });

  afterEach(async () => {
    await cleanupTrackedTempDirsAsync(tempDirs);
  });

  it("returns error when plugin not found", async () => {
    const config = createPluginConfig({});

    const result = await uninstallPlugin({
      config,
      pluginId: "nonexistent",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Plugin not found: nonexistent");
    }
  });

  it("removes config entries", async () => {
    const config = createPluginConfig({
      entries: createSinglePluginEntries(),
      installs: {
        "my-plugin": createNpmInstallRecord(),
      },
    });

    const result = await uninstallPlugin({
      config,
      deleteFiles: false,
      pluginId: "my-plugin",
    });

    const successfulResult = expectSuccessfulUninstall(result);
    expect(successfulResult.config.plugins?.entries).toBeUndefined();
    expect(successfulResult.config.plugins?.installs).toBeUndefined();
    expect(successfulResult.actions.entry).toBe(true);
    expect(successfulResult.actions.install).toBe(true);
  });

  it("deletes directory when deleteFiles is true", async () => {
    const { pluginDir, result } = await runDeleteInstalledNpmPluginFixture(tempDir);

    try {
      expectSuccessfulUninstallActions(result, {
        directory: true,
      });
      await expect(fs.access(pluginDir)).rejects.toThrow();
    } finally {
      await fs.rm(pluginDir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      name: "preserves directory for linked plugins",
      setup: async (baseDir: string) => {
        const pluginDir = await createPluginDirFixture(baseDir);
        return {
          accessPath: pluginDir,
          config: createPluginConfig({
            entries: createSinglePluginEntries(),
            installs: {
              "my-plugin": createPathInstallRecord(pluginDir),
            },
            loadPaths: [pluginDir],
          }),
          deleteFiles: true,
          expectedAccess: "exists" as const,
          expectedActions: {
            directory: false,
            loadPath: true,
          },
        };
      },
    },
    {
      name: "does not delete directory when deleteFiles is false",
      setup: async (baseDir: string) => {
        const pluginDir = await createPluginDirFixture(baseDir);
        return {
          accessPath: pluginDir,
          config: createSingleNpmInstallConfig(pluginDir),
          deleteFiles: false,
          expectedAccess: "exists" as const,
          expectedActions: {
            directory: false,
          },
        };
      },
    },
    {
      name: "succeeds even if directory does not exist",
      setup: async () => ({
        config: createSingleNpmInstallConfig("/nonexistent/path"),
        deleteFiles: true,
        expectedActions: {
          directory: false,
          warnings: [],
        },
      }),
    },
  ] as const)("$name", async ({ setup }) => {
    const params = await setup(tempDir);
    const result = await uninstallPlugin({
      config: params.config,
      deleteFiles: params.deleteFiles,
      pluginId: "my-plugin",
    });

    expectSuccessfulUninstallActions(result, params.expectedActions);
    if ("accessPath" in params && "expectedAccess" in params) {
      await expectPathAccessState(params.accessPath, params.expectedAccess);
    }
  });

  it("returns a warning when directory deletion fails unexpectedly", async () => {
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    try {
      const { result } = await runDeleteInstalledNpmPluginFixture(tempDir);

      const successfulResult = expectSuccessfulUninstallActions(result, {
        directory: false,
      });
      expect(successfulResult.warnings).toHaveLength(1);
      expect(successfulResult.warnings[0]).toContain("Failed to remove plugin directory");
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("never deletes arbitrary configured install paths", async () => {
    const outsideDir = path.join(tempDir, "outside-dir");
    const extensionsDir = path.join(tempDir, "extensions");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "index.js"), "// keep me");

    const config = createSingleNpmInstallConfig(outsideDir);

    const result = await uninstallPlugin({
      config,
      deleteFiles: true,
      extensionsDir,
      pluginId: "my-plugin",
    });

    expectSuccessfulUninstallActions(result, {
      directory: false,
    });
    await expect(fs.access(outsideDir)).resolves.toBeUndefined();
  });
});

describe("resolveUninstallDirectoryTarget", () => {
  it("returns null for linked plugins", () => {
    expect(
      resolveUninstallDirectoryTarget({
        hasInstall: true,
        installRecord: {
          installPath: "/tmp/my-plugin",
          source: "path",
          sourcePath: "/tmp/my-plugin",
        },
        pluginId: "my-plugin",
      }),
    ).toBeNull();
  });

  it("falls back to default path when configured installPath is untrusted", () => {
    const extensionsDir = path.join(os.tmpdir(), "openclaw-uninstall-safe");
    const target = resolveUninstallDirectoryTarget({
      extensionsDir,
      hasInstall: true,
      installRecord: {
        installPath: "/tmp/not-openclaw-plugin-install/my-plugin",
        source: "npm",
        spec: "my-plugin@1.0.0",
      },
      pluginId: "my-plugin",
    });

    expect(target).toBe(resolvePluginInstallDir("my-plugin", extensionsDir));
  });
});
