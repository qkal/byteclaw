import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundledPluginRoot,
  bundledPluginRootAt,
} from "../../../test/helpers/bundled-plugin-paths.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const existsSync = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync,
    },
    existsSync,
  };
});

const installPluginFromNpmSpec = vi.fn();
const applyPluginAutoEnable = vi.fn();
vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnable(...args),
}));

const resolveBundledPluginSources = vi.fn();
const getChannelPluginCatalogEntry = vi.fn();
vi.mock("../../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/catalog.js")>(
    "../../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    getChannelPluginCatalogEntry: (...args: unknown[]) => getChannelPluginCatalogEntry(...args),
  };
});

const loadPluginManifestRegistry = vi.fn();
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistry(...args),
}));

vi.mock("../../plugins/bundled-sources.js", () => ({
  findBundledPluginSourceInMap: ({
    bundled,
    lookup,
  }: {
    bundled: ReadonlyMap<string, { pluginId: string; localPath: string; npmSpec?: string }>;
    lookup: { kind: "pluginId" | "npmSpec"; value: string };
  }) => {
    const targetValue = lookup.value.trim();
    if (!targetValue) {
      return undefined;
    }
    if (lookup.kind === "pluginId") {
      return bundled.get(targetValue);
    }
    for (const source of bundled.values()) {
      if (source.npmSpec === targetValue) {
        return source;
      }
    }
    return undefined;
  },
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSources(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(),
}));

const clearPluginDiscoveryCache = vi.fn();
vi.mock("../../plugins/discovery.js", () => ({
  clearPluginDiscoveryCache: () => clearPluginDiscoveryCache(),
}));

import fs from "node:fs";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { makePrompter, makeRuntime } from "../setup/__tests__/test-utils.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
  reloadChannelSetupPluginRegistry,
  reloadChannelSetupPluginRegistryForChannel,
} from "./plugin-install.js";

const baseEntry: ChannelPluginCatalogEntry = {
  id: "zalo",
  install: {
    localPath: bundledPluginRoot("zalo"),
    npmSpec: "@openclaw/zalo",
  },
  meta: {
    blurb: "Test",
    docsLabel: "zalo",
    docsPath: "/channels/zalo",
    id: "zalo",
    label: "Zalo",
    selectionLabel: "Zalo (Bot API)",
  },
  pluginId: "zalo",
};

beforeEach(() => {
  vi.clearAllMocks();
  applyPluginAutoEnable.mockImplementation((params: { config: unknown }) => ({
    autoEnabledReasons: {},
    changes: [],
    config: params.config,
  }));
  resolveBundledPluginSources.mockReturnValue(new Map());
  getChannelPluginCatalogEntry.mockReturnValue(undefined);
  loadPluginManifestRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function mockRepoLocalPathExists() {
  vi.mocked(fs.existsSync).mockImplementation((value) => {
    const raw = String(value);
    return raw.endsWith(`${path.sep}.git`) || raw.endsWith(`${path.sep}extensions${path.sep}zalo`);
  });
}

async function runInitialValueForChannel(channel: "dev" | "beta") {
  const runtime = makeRuntime();
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
  const cfg: OpenClawConfig = { update: { channel } };
  mockRepoLocalPathExists();

  await ensureChannelSetupPluginInstalled({
    cfg,
    entry: baseEntry,
    prompter,
    runtime,
  });

  const call = select.mock.calls[0];
  return call?.[0]?.initialValue;
}

function expectPluginLoadedFromLocalPath(
  result: Awaited<ReturnType<typeof ensureChannelSetupPluginInstalled>>,
) {
  const expectedPath = path.resolve(process.cwd(), bundledPluginRoot("zalo"));
  expect(result.installed).toBe(true);
  expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
}

describe("ensureChannelSetupPluginInstalled", () => {
  it("installs from npm and enables the plugin", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = { plugins: { allow: ["other"] } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    installPluginFromNpmSpec.mockResolvedValue({
      extensions: [],
      ok: true,
      pluginId: "zalo",
      targetDir: "/tmp/zalo",
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.entries?.zalo?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toContain("zalo");
    expect(result.cfg.plugins?.installs?.zalo?.source).toBe("npm");
    expect(result.cfg.plugins?.installs?.zalo?.spec).toBe("@openclaw/zalo");
    expect(result.cfg.plugins?.installs?.zalo?.installPath).toBe("/tmp/zalo");
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "@openclaw/zalo" }),
    );
  });

  it("uses local path when selected", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = {};
    mockRepoLocalPathExists();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expectPluginLoadedFromLocalPath(result);
    expect(result.cfg.plugins?.entries?.zalo?.enabled).toBe(true);
  });

  it("uses the catalog plugin id for local-path installs", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = {};
    mockRepoLocalPathExists();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        ...baseEntry,
        id: "teams",
        pluginId: "@openclaw/msteams-plugin",
      },
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.pluginId).toBe("@openclaw/msteams-plugin");
    expect(result.cfg.plugins?.entries?.["@openclaw/msteams-plugin"]?.enabled).toBe(true);
  });

  it("defaults to local on dev channel when local path exists", async () => {
    expect(await runInitialValueForChannel("dev")).toBe("local");
  });

  it("defaults to npm on beta channel even when local path exists", async () => {
    expect(await runInitialValueForChannel("beta")).toBe("npm");
  });

  it("defaults to bundled local path on beta channel when available", async () => {
    const runtime = makeRuntime();
    const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
    const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    resolveBundledPluginSources.mockReturnValue(
      new Map([
        [
          "zalo",
          {
            localPath: bundledPluginRootAt("/opt/openclaw", "zalo"),
            npmSpec: "@openclaw/zalo",
            pluginId: "zalo",
          },
        ],
      ]),
    );

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "local",
        options: expect.arrayContaining([
          expect.objectContaining({
            hint: bundledPluginRootAt("/opt/openclaw", "zalo"),
            value: "local",
          }),
        ]),
      }),
    );
  });

  it("does not default to bundled local path when an external catalog overrides the npm spec", async () => {
    const runtime = makeRuntime();
    const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
    const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    resolveBundledPluginSources.mockReturnValue(
      new Map([
        [
          "whatsapp",
          {
            localPath: bundledPluginRootAt("/opt/openclaw", "whatsapp"),
            npmSpec: "@openclaw/whatsapp",
            pluginId: "whatsapp",
          },
        ],
      ]),
    );

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        id: "whatsapp",
        install: {
          npmSpec: "@vendor/whatsapp-fork",
        },
        meta: {
          blurb: "Test",
          docsPath: "/channels/whatsapp",
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
        },
      },
      prompter,
      runtime,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "npm",
        options: [
          expect.objectContaining({
            label: "Download from npm (@vendor/whatsapp-fork)",
            value: "npm",
          }),
          expect.objectContaining({
            value: "skip",
          }),
        ],
      }),
    );
  });

  it("falls back to local path after npm install failure", async () => {
    const runtime = makeRuntime();
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    const prompter = makePrompter({
      confirm,
      note,
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = {};
    mockRepoLocalPathExists();
    installPluginFromNpmSpec.mockResolvedValue({
      error: "nope",
      ok: false,
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expectPluginLoadedFromLocalPath(result);
    expect(note).toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("clears discovery cache before reloading the setup plugin registry", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    reloadChannelSetupPluginRegistry({
      cfg,
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(clearPluginDiscoveryCache).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        cache: false,
        config: cfg,
        includeSetupOnlyChannelPlugins: true,
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(clearPluginDiscoveryCache.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loadOpenClawPlugins).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("loads the setup plugin registry from the auto-enabled config snapshot", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      channels: { telegram: { enabled: true } } as never,
      plugins: {},
    };
    const autoEnabledConfig = {
      ...cfg,
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    } as OpenClawConfig;
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {},
      changes: [],
      config: autoEnabledConfig,
    });

    reloadChannelSetupPluginRegistry({
      cfg,
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        config: autoEnabledConfig,
      }),
    );
  });

  it("scopes channel reloads when setup starts from an empty registry", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@openclaw/telegram-plugin" });

    reloadChannelSetupPluginRegistryForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        cache: false,
        config: cfg,
        includeSetupOnlyChannelPlugins: true,
        onlyPluginIds: ["@openclaw/telegram-plugin"],
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("telegram", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("keeps full reloads when the active plugin registry is already populated", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        configSchema: true,
        id: "loaded",
        name: "loaded",
        origin: "bundled",
        source: "/tmp/loaded.cjs",
      }),
    );
    setActivePluginRegistry(registry);

    reloadChannelSetupPluginRegistryForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
  });

  it("scopes channel reloads when the global registry is populated but the pinned channel registry is empty", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@openclaw/telegram-plugin" });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push(
      createPluginRecord({
        id: "loaded-tools",
        name: "loaded-tools",
        origin: "bundled",
        source: "/tmp/loaded-tools.cjs",
      }),
    );
    setActivePluginRegistry(activeRegistry);
    const pinnedChannelRegistry = createEmptyPluginRegistry();
    pinActivePluginChannelRegistry(pinnedChannelRegistry);

    try {
      reloadChannelSetupPluginRegistryForChannel({
        cfg,
        channel: "telegram",
        runtime,
        workspaceDir: "/tmp/openclaw-workspace",
      });
    } finally {
      releasePinnedPluginChannelRegistry(pinnedChannelRegistry);
    }

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        onlyPluginIds: ["@openclaw/telegram-plugin"],
      }),
    );
  });

  it("can load a channel-scoped snapshot without activating the global registry", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@openclaw/telegram-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        cache: false,
        config: cfg,
        includeSetupOnlyChannelPlugins: true,
        onlyPluginIds: ["@openclaw/telegram-plugin"],
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("telegram", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("falls back to the bundled plugin for untrusted workspace shadows", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry
      .mockReturnValueOnce({ origin: "workspace", pluginId: "evil-telegram-shadow" })
      .mockReturnValueOnce({ origin: "bundled", pluginId: "@openclaw/telegram-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["@openclaw/telegram-plugin"],
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "telegram", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "telegram", {
      excludeWorkspace: true,
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("keeps trusted workspace overrides scoped during setup reloads", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["trusted-telegram-shadow"],
        enabled: true,
      },
    };
    getChannelPluginCatalogEntry.mockReturnValue({
      origin: "workspace",
      pluginId: "trusted-telegram-shadow",
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["trusted-telegram-shadow"],
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledTimes(1);
  });

  it("does not scope by raw channel id when no trusted plugin mapping exists", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
  });

  it("scopes snapshots by a unique discovered manifest match when catalog mapping is missing", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [{ channels: ["telegram"], id: "custom-telegram-plugin" }],
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      channel: "telegram",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        cache: false,
        config: cfg,
        includeSetupOnlyChannelPlugins: true,
        onlyPluginIds: ["custom-telegram-plugin"],
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });

  it("scopes snapshots by plugin id when channel and plugin ids differ", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      channel: "msteams",
      pluginId: "@openclaw/msteams-plugin",
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        cache: false,
        config: cfg,
        includeSetupOnlyChannelPlugins: true,
        onlyPluginIds: ["@openclaw/msteams-plugin"],
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });
});
