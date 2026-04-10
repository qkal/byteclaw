import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginCommands, getPluginCommandSpecs } from "./command-registry-state.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createHookRunner } from "./hooks.js";
import {
  PluginLoadReentryError,
  __testing,
  clearPluginLoaderCache,
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  type PluginLoadConfig,
  type PluginRegistry,
  type TempPlugin,
  cleanupPluginLoaderFixturesForTest,
  makeTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  listMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryPromptSupplement,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
} from "./memory-state.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  listImportedRuntimePluginIds,
  setActivePluginRegistry,
} from "./runtime.js";
import type { PluginSdkResolutionPreference } from "./sdk-alias.js";
let cachedBundledTelegramDir = "";
let cachedBundledMemoryDir = "";
const BUNDLED_TELEGRAM_PLUGIN_BODY = `module.exports = {
  id: "telegram",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "telegram",
        meta: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "telegram channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`;

function simplePluginBody(id: string) {
  return `module.exports = { id: ${JSON.stringify(id)}, register() {} };`;
}

function memoryPluginBody(id: string) {
  return `module.exports = { id: ${JSON.stringify(id)}, kind: "memory", register() {} };`;
}

const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";
const RESERVED_ADMIN_SCOPE_WARNING =
  "gateway method scope coerced to operator.admin for reserved core namespace";

function writeBundledPlugin(params: {
  id: string;
  body?: string;
  filename?: string;
  bundledDir?: string;
}) {
  const bundledDir = params.bundledDir ?? makeTempDir();
  const plugin = writePlugin({
    body: params.body ?? simplePluginBody(params.id),
    dir: bundledDir,
    filename: params.filename ?? "index.cjs",
    id: params.id,
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
  return { bundledDir, plugin };
}

function writeWorkspacePlugin(params: {
  id: string;
  body?: string;
  filename?: string;
  workspaceDir?: string;
}) {
  const workspaceDir = params.workspaceDir ?? makeTempDir();
  const workspacePluginDir = path.join(workspaceDir, ".openclaw", "extensions", params.id);
  mkdirSafe(workspacePluginDir);
  const plugin = writePlugin({
    body: params.body ?? simplePluginBody(params.id),
    dir: workspacePluginDir,
    filename: params.filename ?? "index.cjs",
    id: params.id,
  });
  return { plugin, workspaceDir, workspacePluginDir };
}

function withStateDir<T>(run: (stateDir: string) => T) {
  const stateDir = makeTempDir();
  return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => run(stateDir));
}

function loadBundledMemoryPluginRegistry(options?: {
  packageMeta?: { name: string; version: string; description?: string };
  pluginBody?: string;
  pluginFilename?: string;
}) {
  if (!options && cachedBundledMemoryDir) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = cachedBundledMemoryDir;
    return loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
          },
        },
      },
      workspaceDir: cachedBundledMemoryDir,
    });
  }

  const bundledDir = makeTempDir();
  let pluginDir = bundledDir;
  let pluginFilename = options?.pluginFilename ?? "memory-core.cjs";

  if (options?.packageMeta) {
    pluginDir = path.join(bundledDir, "memory-core");
    pluginFilename = options.pluginFilename ?? "index.js";
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          description: options.packageMeta.description,
          name: options.packageMeta.name,
          openclaw: { extensions: [`./${pluginFilename}`] },
          version: options.packageMeta.version,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  writePlugin({
    body:
      options?.pluginBody ??
      `module.exports = { id: "memory-core", kind: "memory", register() {} };`,
    dir: pluginDir,
    filename: pluginFilename,
    id: "memory-core",
  });
  if (!options) {
    cachedBundledMemoryDir = bundledDir;
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

  return loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    },
    workspaceDir: bundledDir,
  });
}

function setupBundledTelegramPlugin() {
  if (!cachedBundledTelegramDir) {
    cachedBundledTelegramDir = makeTempDir();
    writePlugin({
      body: BUNDLED_TELEGRAM_PLUGIN_BODY,
      dir: cachedBundledTelegramDir,
      filename: "telegram.cjs",
      id: "telegram",
    });
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = cachedBundledTelegramDir;
}

function expectTelegramLoaded(registry: ReturnType<typeof loadOpenClawPlugins>) {
  const telegram = registry.plugins.find((entry) => entry.id === "telegram");
  expect(telegram?.status).toBe("loaded");
  expect(registry.channels.some((entry) => entry.plugin.id === "telegram")).toBe(true);
}

function loadRegistryFromSinglePlugin(params: {
  plugin: TempPlugin;
  pluginConfig?: Record<string, unknown>;
  includeWorkspaceDir?: boolean;
  options?: Omit<Parameters<typeof loadOpenClawPlugins>[0], "cache" | "workspaceDir" | "config">;
}) {
  const pluginConfig = params.pluginConfig ?? {};
  return loadOpenClawPlugins({
    cache: false,
    ...(params.includeWorkspaceDir === false ? {} : { workspaceDir: params.plugin.dir }),
    ...params.options,
    config: {
      plugins: {
        load: { paths: [params.plugin.file] },
        ...pluginConfig,
      },
    },
  });
}

function loadRegistryFromAllowedPlugins(
  plugins: TempPlugin[],
  options?: Omit<Parameters<typeof loadOpenClawPlugins>[0], "cache" | "config">,
) {
  return loadOpenClawPlugins({
    cache: false,
    ...options,
    config: {
      plugins: {
        allow: plugins.map((plugin) => plugin.id),
        load: { paths: plugins.map((plugin) => plugin.file) },
      },
    },
  });
}

function runRegistryScenarios<
  T extends { assert: (registry: PluginRegistry, scenario: T) => void },
>(scenarios: readonly T[], loadRegistry: (scenario: T) => PluginRegistry) {
  for (const scenario of scenarios) {
    scenario.assert(loadRegistry(scenario), scenario);
  }
}

function runScenarioCases<T>(scenarios: readonly T[], run: (scenario: T) => void) {
  for (const scenario of scenarios) {
    run(scenario);
  }
}

function runSinglePluginRegistryScenarios<
  T extends {
    pluginId: string;
    body: string;
    assert: (registry: PluginRegistry, scenario: T) => void;
  },
>(scenarios: readonly T[], resolvePluginConfig?: (scenario: T) => Record<string, unknown>) {
  runRegistryScenarios(scenarios, (scenario) => {
    const plugin = writePlugin({
      body: scenario.body,
      filename: `${scenario.pluginId}.cjs`,
      id: scenario.pluginId,
    });
    return loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: resolvePluginConfig?.(scenario) ?? { allow: [scenario.pluginId] },
    });
  });
}

function loadRegistryFromScenarioPlugins(plugins: readonly TempPlugin[]) {
  return plugins.length === 1
    ? loadRegistryFromSinglePlugin({
        plugin: plugins[0],
        pluginConfig: {
          allow: [plugins[0].id],
        },
      })
    : loadRegistryFromAllowedPlugins([...plugins]);
}

function expectOpenAllowWarnings(params: {
  warnings: string[];
  pluginId: string;
  expectedWarnings: number;
  label: string;
}) {
  const openAllowWarnings = params.warnings.filter((msg) => msg.includes("plugins.allow is empty"));
  expect(openAllowWarnings, params.label).toHaveLength(params.expectedWarnings);
  if (params.expectedWarnings > 0) {
    expect(
      openAllowWarnings.some((msg) => msg.includes(params.pluginId)),
      params.label,
    ).toBe(true);
  }
}

function expectLoadedPluginProvenance(params: {
  scenario: { label: string };
  registry: PluginRegistry;
  warnings: string[];
  pluginId: string;
  expectWarning: boolean;
  expectedSource?: string;
}) {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  expect(plugin?.status, params.scenario.label).toBe("loaded");
  if (params.expectedSource) {
    expect(plugin?.source, params.scenario.label).toBe(params.expectedSource);
  }
  expect(
    params.warnings.some(
      (msg) =>
        msg.includes(params.pluginId) &&
        msg.includes("loaded without install/load-path provenance"),
    ),
    params.scenario.label,
  ).toBe(params.expectWarning);
}

function expectRegisteredHttpRoute(
  registry: PluginRegistry,
  scenario: {
    pluginId: string;
    expectedPath: string;
    expectedAuth: string;
    expectedMatch: string;
    label: string;
  },
) {
  const route = registry.httpRoutes.find((entry) => entry.pluginId === scenario.pluginId);
  expect(route, scenario.label).toBeDefined();
  expect(route?.path, scenario.label).toBe(scenario.expectedPath);
  expect(route?.auth, scenario.label).toBe(scenario.expectedAuth);
  expect(route?.match, scenario.label).toBe(scenario.expectedMatch);
  const httpPlugin = registry.plugins.find((entry) => entry.id === scenario.pluginId);
  expect(httpPlugin?.httpRoutes, scenario.label).toBe(1);
}

function expectDuplicateRegistrationResult(
  registry: PluginRegistry,
  scenario: {
    selectCount: (registry: PluginRegistry) => number;
    ownerB: string;
    duplicateMessage: string;
    label: string;
    assertPrimaryOwner?: (registry: PluginRegistry) => void;
  },
) {
  expect(scenario.selectCount(registry), scenario.label).toBe(1);
  scenario.assertPrimaryOwner?.(registry);
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.level === "error" &&
        diag.pluginId === scenario.ownerB &&
        diag.message === scenario.duplicateMessage,
    ),
    scenario.label,
  ).toBe(true);
}

function expectPluginSourcePrecedence(
  registry: PluginRegistry,
  scenario: {
    pluginId: string;
    expectedLoadedOrigin: string;
    expectedDisabledOrigin: string;
    label: string;
    expectedDisabledError?: string;
  },
) {
  const entries = registry.plugins.filter((entry) => entry.id === scenario.pluginId);
  const loaded = entries.find((entry) => entry.status === "loaded");
  const overridden = entries.find((entry) => entry.status === "disabled");
  expect(loaded?.origin, scenario.label).toBe(scenario.expectedLoadedOrigin);
  expect(overridden?.origin, scenario.label).toBe(scenario.expectedDisabledOrigin);
  if (scenario.expectedDisabledError) {
    expect(overridden?.error, scenario.label).toContain(scenario.expectedDisabledError);
  }
}

function expectPluginOriginAndStatus(params: {
  registry: PluginRegistry;
  pluginId: string;
  origin: string;
  status: string;
  label: string;
  errorIncludes?: string;
}) {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  expect(plugin?.origin, params.label).toBe(params.origin);
  expect(plugin?.status, params.label).toBe(params.status);
  if (params.errorIncludes) {
    expect(plugin?.error, params.label).toContain(params.errorIncludes);
  }
}

function expectRegistryErrorDiagnostic(params: {
  registry: PluginRegistry;
  pluginId: string;
  message: string;
}) {
  expect(
    params.registry.diagnostics.some(
      (diag) =>
        diag.level === "error" &&
        diag.pluginId === params.pluginId &&
        diag.message === params.message,
    ),
  ).toBe(true);
}

function createWarningLogger(warnings: string[]) {
  return {
    error: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
  };
}

function createErrorLogger(errors: string[]) {
  return {
    debug: () => {},
    error: (msg: string) => errors.push(msg),
    info: () => {},
    warn: () => {},
  };
}

function createEscapingEntryFixture(params: { id: string; sourceBody: string }) {
  const pluginDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideEntry = path.join(outsideDir, "outside.cjs");
  const linkedEntry = path.join(pluginDir, "entry.cjs");
  fs.writeFileSync(outsideEntry, params.sourceBody, "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        configSchema: EMPTY_PLUGIN_SCHEMA,
        id: params.id,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { linkedEntry, outsideEntry, pluginDir };
}

function resolveLoadedPluginSource(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
) {
  return fs.realpathSync(registry.plugins.find((entry) => entry.id === pluginId)?.source ?? "");
}

function expectCachePartitionByPluginSource(params: {
  pluginId: string;
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadSecond: () => ReturnType<typeof loadOpenClawPlugins>;
  expectedFirstSource: string;
  expectedSecondSource: string;
}) {
  const first = params.loadFirst();
  const second = params.loadSecond();

  expect(second).not.toBe(first);
  expect(resolveLoadedPluginSource(first, params.pluginId)).toBe(
    fs.realpathSync(params.expectedFirstSource),
  );
  expect(resolveLoadedPluginSource(second, params.pluginId)).toBe(
    fs.realpathSync(params.expectedSecondSource),
  );
}

function expectCacheMissThenHit(params: {
  loadFirst: () => ReturnType<typeof loadOpenClawPlugins>;
  loadVariant: () => ReturnType<typeof loadOpenClawPlugins>;
}) {
  const first = params.loadFirst();
  const second = params.loadVariant();
  const third = params.loadVariant();

  expect(second).not.toBe(first);
  expect(third).toBe(second);
}

function createSetupEntryChannelPluginFixture(params: {
  id: string;
  label: string;
  packageName: string;
  fullBlurb: string;
  setupBlurb: string;
  configured: boolean;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
}) {
  useNoBundledPlugins();
  const pluginDir = makeTempDir();
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  const listAccountIds = params.configured ? '["default"]' : "[]";
  const resolveAccount = params.configured
    ? '({ accountId: "default", token: "configured" })'
    : '({ accountId: "default" })';

  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: params.packageName,
        openclaw: {
          extensions: ["./index.cjs"],
          setupEntry: "./setup-entry.cjs",
          ...(params.startupDeferConfiguredChannelFullLoadUntilAfterListen
            ? {
                startup: {
                  deferConfiguredChannelFullLoadUntilAfterListen: true,
                },
              }
            : {}),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        channels: [params.id],
        configSchema: EMPTY_PLUGIN_SCHEMA,
        id: params.id,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");
module.exports = {
  id: ${JSON.stringify(params.id)},
  register(api) {
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(params.id)},
        meta: {
          id: ${JSON.stringify(params.id)},
          label: ${JSON.stringify(params.label)},
          selectionLabel: ${JSON.stringify(params.label)},
          docsPath: ${JSON.stringify(`/channels/${params.id}`)},
          blurb: ${JSON.stringify(params.fullBlurb)},
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ${listAccountIds},
          resolveAccount: () => ${resolveAccount},
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "setup-entry.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");
module.exports = {
  plugin: {
    id: ${JSON.stringify(params.id)},
    meta: {
      id: ${JSON.stringify(params.id)},
      label: ${JSON.stringify(params.label)},
      selectionLabel: ${JSON.stringify(params.label)},
      docsPath: ${JSON.stringify(`/channels/${params.id}`)},
      blurb: ${JSON.stringify(params.setupBlurb)},
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ${listAccountIds},
      resolveAccount: () => ${resolveAccount},
    },
    outbound: { deliveryMode: "direct" },
  },
};`,
    "utf8",
  );

  return { fullMarker, pluginDir, setupMarker };
}

function createEnvResolvedPluginFixture(pluginId: string) {
  useNoBundledPlugins();
  const openclawHome = makeTempDir();
  const ignoredHome = makeTempDir();
  const stateDir = makeTempDir();
  const pluginDir = path.join(openclawHome, "plugins", pluginId);
  mkdirSafe(pluginDir);
  const plugin = writePlugin({
    body: `module.exports = { id: ${JSON.stringify(pluginId)}, register() {} };`,
    dir: pluginDir,
    filename: "index.cjs",
    id: pluginId,
  });
  const env = {
    ...process.env,
    HOME: ignoredHome,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_STATE_DIR: stateDir,
  };
  return { env, plugin };
}

function expectEscapingEntryRejected(params: {
  id: string;
  linkKind: "symlink" | "hardlink";
  sourceBody: string;
}) {
  useNoBundledPlugins();
  const { outsideEntry, linkedEntry } = createEscapingEntryFixture({
    id: params.id,
    sourceBody: params.sourceBody,
  });
  try {
    if (params.linkKind === "symlink") {
      fs.symlinkSync(outsideEntry, linkedEntry);
    } else {
      fs.linkSync(outsideEntry, linkedEntry);
    }
  } catch (error) {
    if (params.linkKind === "hardlink" && (error as NodeJS.ErrnoException).code === "EXDEV") {
      return undefined;
    }
    if (params.linkKind === "symlink") {
      return undefined;
    }
    throw error;
  }

  const registry = loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        allow: [params.id],
        load: { paths: [linkedEntry] },
      },
    },
  });

  const record = registry.plugins.find((entry) => entry.id === params.id);
  expect(record?.status).not.toBe("loaded");
  expect(registry.diagnostics.some((entry) => entry.message.includes("escapes"))).toBe(true);
  return registry;
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
  cachedBundledTelegramDir = "";
  cachedBundledMemoryDir = "";
});

describe("loadOpenClawPlugins", () => {
  it("disables bundled plugins by default", () => {
    const bundledDir = makeTempDir();
    writePlugin({
      body: `module.exports = { id: "bundled", register() {} };`,
      dir: bundledDir,
      filename: "bundled.cjs",
      id: "bundled",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["bundled"],
        },
      },
    });

    const bundled = registry.plugins.find((entry) => entry.id === "bundled");
    expect(bundled?.status).toBe("disabled");
  });

  it.each([
    {
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        expectTelegramLoaded(registry);
      },
      config: {
        plugins: {
          allow: ["telegram"],
          entries: {
            telegram: { enabled: true },
          },
        },
      } satisfies PluginLoadConfig,
      name: "loads bundled telegram plugin when enabled",
    },
    {
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        expectTelegramLoaded(registry);
      },
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          enabled: true,
        },
      } satisfies PluginLoadConfig,
      name: "loads bundled channel plugins when channels.<id>.enabled=true",
    },
    {
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const telegram = registry.plugins.find((entry) => entry.id === "telegram");
        expect(telegram?.status).toBe("loaded");
        expect(telegram?.error).toBeUndefined();
        expect(telegram?.explicitlyEnabled).toBe(true);
      },
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } satisfies PluginLoadConfig,
      name: "lets explicit bundled channel enablement bypass restrictive allowlists",
    },
    {
      assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const telegram = registry.plugins.find((entry) => entry.id === "telegram");
        expect(telegram?.status).toBe("disabled");
        expect(telegram?.error).toBe("disabled in config");
      },
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: { enabled: false },
          },
        },
      } satisfies PluginLoadConfig,
      name: "still respects explicit disable via plugins.entries for bundled channels",
    },
  ] as const)(
    "handles bundled telegram plugin enablement and override rules: $name",
    ({ config, assert }) => {
      setupBundledTelegramPlugin();
      const registry = loadOpenClawPlugins({
        cache: false,
        config,
        workspaceDir: cachedBundledTelegramDir,
      });
      assert(registry);
    },
  );

  it("marks auto-enabled bundled channels as activated but not explicitly enabled", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        enabled: true,
      },
    } satisfies PluginLoadConfig;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env: {},
    });

    const registry = loadOpenClawPlugins({
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      cache: false,
      config: autoEnabled.config,
      workspaceDir: cachedBundledTelegramDir,
    });

    expect(registry.plugins.find((entry) => entry.id === "telegram")).toMatchObject({
      activated: true,
      activationReason: "telegram configured",
      activationSource: "auto",
      explicitlyEnabled: false,
    });
  });

  it("keeps auto-enabled bundled channels behind restrictive allowlists", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        allow: ["browser"],
      },
    } satisfies PluginLoadConfig;
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env: {},
    });

    const registry = loadOpenClawPlugins({
      activationSourceConfig: rawConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      cache: false,
      config: autoEnabled.config,
      workspaceDir: cachedBundledTelegramDir,
    });

    const telegram = registry.plugins.find((entry) => entry.id === "telegram");
    expect(telegram?.status).toBe("disabled");
    expect(telegram?.error).toBe("not in allowlist");
  });

  it("preserves all auto-enable reasons in activation metadata", () => {
    setupBundledTelegramPlugin();
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "x",
        },
      },
      plugins: {
        enabled: true,
      },
    } satisfies PluginLoadConfig;

    const registry = loadOpenClawPlugins({
      activationSourceConfig: rawConfig,
      autoEnabledReasons: {
        telegram: ["telegram configured", "telegram selected for startup"],
      },
      cache: false,
      config: {
        ...rawConfig,
        plugins: {
          enabled: true,
          entries: {
            telegram: {
              enabled: true,
            },
          },
        },
      },
      workspaceDir: cachedBundledTelegramDir,
    });

    expect(registry.plugins.find((entry) => entry.id === "telegram")).toMatchObject({
      activated: true,
      activationReason: "telegram configured; telegram selected for startup",
      activationSource: "auto",
      explicitlyEnabled: false,
    });
  });

  it("keeps explicit plugin enablement distinct from derived activation", () => {
    const { bundledDir } = writeBundledPlugin({
      id: "demo",
    });
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: true,
          },
        },
      },
    } satisfies PluginLoadConfig;

    const registry = loadOpenClawPlugins({
      activationSourceConfig: config,
      cache: false,
      config,
      workspaceDir: bundledDir,
    });

    expect(registry.plugins.find((entry) => entry.id === "demo")).toMatchObject({
      activated: true,
      activationReason: "enabled in config",
      activationSource: "explicit",
      explicitlyEnabled: true,
    });
  });

  it("preserves package.json metadata for bundled memory plugins", () => {
    const registry = loadBundledMemoryPluginRegistry({
      packageMeta: {
        description: "Memory plugin package",
        name: "@openclaw/memory-core",
        version: "1.2.3",
      },
      pluginBody:
        'module.exports = { id: "memory-core", kind: "memory", name: "Memory (Core)", register() {} };',
    });

    const memory = registry.plugins.find((entry) => entry.id === "memory-core");
    expect(memory?.status).toBe("loaded");
    expect(memory?.origin).toBe("bundled");
    expect(memory?.name).toBe("Memory (Core)");
    expect(memory?.version).toBe("1.2.3");
  });
  it.each([
    {
      label: "loads plugins from config paths",
      run: () => {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
        const plugin = writePlugin({
          body: `module.exports = {
  id: "allowed-config-path",
  register(api) {
    api.registerGatewayMethod("allowed-config-path.ping", ({ respond }) => respond(true, { ok: true }));
  },
};`,
          filename: "allowed-config-path.cjs",
          id: "allowed-config-path",
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              allow: ["allowed-config-path"],
              load: { paths: [plugin.file] },
            },
          },
          workspaceDir: plugin.dir,
        });

        const loaded = registry.plugins.find((entry) => entry.id === "allowed-config-path");
        expect(loaded?.status).toBe("loaded");
        expect(Object.keys(registry.gatewayHandlers)).toContain("allowed-config-path.ping");
      },
    },
    {
      label: "coerces reserved gateway method namespaces to operator.admin",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          body: `module.exports = {
  id: "reserved-gateway-scope",
  register(api) {
    api.registerGatewayMethod(
      ${JSON.stringify(RESERVED_ADMIN_PLUGIN_METHOD)},
      ({ respond }) => respond(true, { ok: true }),
      { scope: "operator.read" },
    );
  },
};`,
          filename: "reserved-gateway-scope.cjs",
          id: "reserved-gateway-scope",
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              allow: ["reserved-gateway-scope"],
              load: { paths: [plugin.file] },
            },
          },
          workspaceDir: plugin.dir,
        });

        expect(Object.keys(registry.gatewayHandlers)).toContain(RESERVED_ADMIN_PLUGIN_METHOD);
        expect(registry.gatewayMethodScopes?.[RESERVED_ADMIN_PLUGIN_METHOD]).toBe("operator.admin");
        expect(
          registry.diagnostics.some((diag) =>
            String(diag.message).includes(
              `${RESERVED_ADMIN_SCOPE_WARNING}: ${RESERVED_ADMIN_PLUGIN_METHOD}`,
            ),
          ),
        ).toBe(true);
      },
    },
    {
      label: "limits imports to the requested plugin ids",
      run: () => {
        useNoBundledPlugins();
        const allowed = writePlugin({
          body: `module.exports = { id: "allowed-scoped-only", register() {} };`,
          filename: "allowed-scoped-only.cjs",
          id: "allowed-scoped-only",
        });
        const skippedMarker = path.join(makeTempDir(), "skipped-loaded.txt");
        const skipped = writePlugin({
          body: `require("node:fs").writeFileSync(${JSON.stringify(skippedMarker)}, "loaded", "utf-8");
module.exports = { id: "skipped-scoped-only", register() { throw new Error("skipped plugin should not load"); } };`,
          filename: "skipped-scoped-only.cjs",
          id: "skipped-scoped-only",
        });

        const registry = loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              allow: ["allowed-scoped-only", "skipped-scoped-only"],
              load: { paths: [allowed.file, skipped.file] },
            },
          },
          onlyPluginIds: ["allowed-scoped-only"],
        });

        expect(registry.plugins.map((entry) => entry.id)).toEqual(["allowed-scoped-only"]);
        expect(fs.existsSync(skippedMarker)).toBe(false);
      },
    },
    {
      label: "can build a manifest-only snapshot without importing plugin modules",
      run: () => {
        useNoBundledPlugins();
        const importedMarker = path.join(makeTempDir(), "manifest-only-imported.txt");
        const plugin = writePlugin({
          body: `require("node:fs").writeFileSync(${JSON.stringify(importedMarker)}, "loaded", "utf-8");
module.exports = { id: "manifest-only-plugin", register() { throw new Error("manifest-only snapshot should not register"); } };`,
          filename: "manifest-only-plugin.cjs",
          id: "manifest-only-plugin",
        });

        const registry = loadOpenClawPlugins({
          activate: false,
          cache: false,
          config: {
            plugins: {
              allow: ["manifest-only-plugin"],
              entries: {
                "manifest-only-plugin": { enabled: true },
              },
              load: { paths: [plugin.file] },
            },
          },
          loadModules: false,
        });

        expect(fs.existsSync(importedMarker)).toBe(false);
        expect(registry.plugins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "manifest-only-plugin",
              status: "loaded",
            }),
          ]),
        );
      },
    },
    {
      label: "marks a selected memory slot as matched during manifest-only snapshots",
      run: () => {
        useNoBundledPlugins();
        const memoryPlugin = writePlugin({
          body: `module.exports = {
  id: "memory-demo",
  kind: "memory",
  register() {},
};`,
          filename: "memory-demo.cjs",
          id: "memory-demo",
        });
        fs.writeFileSync(
          path.join(memoryPlugin.dir, "openclaw.plugin.json"),
          JSON.stringify(
            {
              configSchema: EMPTY_PLUGIN_SCHEMA,
              id: "memory-demo",
              kind: "memory",
            },
            null,
            2,
          ),
          "utf8",
        );

        const registry = loadOpenClawPlugins({
          activate: false,
          cache: false,
          config: {
            plugins: {
              allow: ["memory-demo"],
              entries: {
                "memory-demo": { enabled: true },
              },
              load: { paths: [memoryPlugin.file] },
              slots: { memory: "memory-demo" },
            },
          },
          loadModules: false,
        });

        expect(
          registry.diagnostics.some(
            (entry) =>
              entry.message === "memory slot plugin not found or not marked as memory: memory-demo",
          ),
        ).toBe(false);
        expect(registry.plugins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "memory-demo",
              memorySlotSelected: true,
            }),
          ]),
        );
      },
    },
    {
      label: "tracks plugins as imported when module evaluation throws after top-level execution",
      run: () => {
        useNoBundledPlugins();
        const importMarker = "__openclaw_loader_import_throw_marker";
        Reflect.deleteProperty(globalThis, importMarker);

        const plugin = writePlugin({
          body: `globalThis.${importMarker} = (globalThis.${importMarker} ?? 0) + 1;
throw new Error("boom after import");
module.exports = { id: "throws-after-import", register() {} };`,
          filename: "throws-after-import.cjs",
          id: "throws-after-import",
        });

        const registry = loadOpenClawPlugins({
          activate: false,
          cache: false,
          config: {
            plugins: {
              allow: ["throws-after-import"],
              load: { paths: [plugin.file] },
            },
          },
        });

        try {
          expect(registry.plugins).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "throws-after-import",
                status: "error",
              }),
            ]),
          );
          expect(listImportedRuntimePluginIds()).toContain("throws-after-import");
          expect(Number(Reflect.get(globalThis, importMarker) ?? 0)).toBeGreaterThan(0);
        } finally {
          Reflect.deleteProperty(globalThis, importMarker);
        }
      },
    },
    {
      label: "fails loudly when a plugin reenters the same snapshot load during register",
      run: () => {
        useNoBundledPlugins();
        const marker = "__openclaw_loader_reentry_error";
        const reenterFnMarker = "__openclaw_loader_reentry_fn";
        Reflect.deleteProperty(globalThis, marker);
        Reflect.set(
          globalThis,
          reenterFnMarker,
          (options: Parameters<typeof loadOpenClawPlugins>[0]) => loadOpenClawPlugins(options),
        );
        const pluginDir = makeTempDir();
        const pluginFile = path.join(pluginDir, "reentrant-snapshot.cjs");
        const nestedOptions = {
          activate: false,
          cache: false,
          config: {
            plugins: {
              allow: ["reentrant-snapshot"],
              load: { paths: [pluginFile] },
            },
          },
          workspaceDir: pluginDir,
        } satisfies Parameters<typeof loadOpenClawPlugins>[0];
        writePlugin({
          body: `module.exports = {
  id: "reentrant-snapshot",
  register() {
    try {
      globalThis.${reenterFnMarker}(${JSON.stringify(nestedOptions)});
    } catch (error) {
      globalThis.${marker} = {
        name: error?.name,
        message: String(error?.message ?? error),
      };
      throw error;
    }
  },
};`,
          dir: pluginDir,
          filename: "reentrant-snapshot.cjs",
          id: "reentrant-snapshot",
        });

        const registry = loadOpenClawPlugins(nestedOptions);

        try {
          expect(Reflect.get(globalThis, marker)).toMatchObject({
            message: expect.stringContaining("plugin load reentry detected"),
            name: PluginLoadReentryError.name,
          });
          expect(registry.plugins.find((entry) => entry.id === "reentrant-snapshot")).toMatchObject(
            {
              error: expect.stringContaining("plugin load reentry detected"),
              failurePhase: "register",
              status: "error",
            },
          );
        } finally {
          Reflect.deleteProperty(globalThis, marker);
          Reflect.deleteProperty(globalThis, reenterFnMarker);
        }
      },
    },
    {
      label: "lets resolveRuntimePluginRegistry short-circuit during same snapshot load",
      run: () => {
        useNoBundledPlugins();
        const marker = "__openclaw_runtime_registry_reentry_marker";
        const resolverMarker = "__openclaw_runtime_registry_reentry_fn";
        Reflect.deleteProperty(globalThis, marker);
        Reflect.set(
          globalThis,
          resolverMarker,
          (options: Parameters<typeof resolveRuntimePluginRegistry>[0]) =>
            resolveRuntimePluginRegistry(options),
        );
        const pluginDir = makeTempDir();
        const pluginFile = path.join(pluginDir, "runtime-registry-reentry.cjs");
        const nestedOptions = {
          activate: false,
          cache: false,
          config: {
            plugins: {
              allow: ["runtime-registry-reentry"],
              load: { paths: [pluginFile] },
            },
          },
          workspaceDir: pluginDir,
        } satisfies Parameters<typeof loadOpenClawPlugins>[0];
        writePlugin({
          body: `module.exports = {
  id: "runtime-registry-reentry",
  register() {
    const registry = globalThis.${resolverMarker}(${JSON.stringify(nestedOptions)});
    globalThis.${marker} = registry === undefined ? "undefined" : "loaded";
  },
};`,
          dir: pluginDir,
          filename: "runtime-registry-reentry.cjs",
          id: "runtime-registry-reentry",
        });

        const registry = loadOpenClawPlugins(nestedOptions);

        try {
          expect(Reflect.get(globalThis, marker)).toBe("undefined");
          expect(
            registry.plugins.find((entry) => entry.id === "runtime-registry-reentry"),
          ).toMatchObject({
            status: "loaded",
          });
        } finally {
          Reflect.deleteProperty(globalThis, marker);
          Reflect.deleteProperty(globalThis, resolverMarker);
        }
      },
    },
    {
      label: "keeps scoped plugin loads in a separate cache entry",
      run: () => {
        useNoBundledPlugins();
        const allowed = writePlugin({
          body: `module.exports = { id: "allowed-cache-scope", register() {} };`,
          filename: "allowed-cache-scope.cjs",
          id: "allowed-cache-scope",
        });
        const extra = writePlugin({
          body: `module.exports = { id: "extra-cache-scope", register() {} };`,
          filename: "extra-cache-scope.cjs",
          id: "extra-cache-scope",
        });
        const options = {
          config: {
            plugins: {
              allow: ["allowed-cache-scope", "extra-cache-scope"],
              load: { paths: [allowed.file, extra.file] },
            },
          },
        };

        const full = loadOpenClawPlugins(options);
        const scoped = loadOpenClawPlugins({
          ...options,
          onlyPluginIds: ["allowed-cache-scope"],
        });
        const scopedAgain = loadOpenClawPlugins({
          ...options,
          onlyPluginIds: ["allowed-cache-scope"],
        });

        expect(full.plugins.map((entry) => entry.id).toSorted()).toEqual([
          "allowed-cache-scope",
          "extra-cache-scope",
        ]);
        expect(scoped).not.toBe(full);
        expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-cache-scope"]);
        expect(scopedAgain).toBe(scoped);
      },
    },
    {
      label: "can load a scoped registry without replacing the active global registry",
      run: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          body: `module.exports = { id: "allowed-nonactivating-scope", register() {} };`,
          filename: "allowed-nonactivating-scope.cjs",
          id: "allowed-nonactivating-scope",
        });
        const previousRegistry = createEmptyPluginRegistry();
        setActivePluginRegistry(previousRegistry, "existing-registry");
        resetGlobalHookRunner();

        const scoped = loadOpenClawPlugins({
          activate: false,
          cache: false,
          config: {
            plugins: {
              allow: ["allowed-nonactivating-scope"],
              load: { paths: [plugin.file] },
            },
          },
          onlyPluginIds: ["allowed-nonactivating-scope"],
          workspaceDir: plugin.dir,
        });

        expect(scoped.plugins.map((entry) => entry.id)).toEqual(["allowed-nonactivating-scope"]);
        expect(getActivePluginRegistry()).toBe(previousRegistry);
        expect(getActivePluginRegistryKey()).toBe("existing-registry");
        expect(getGlobalHookRunner()).toBeNull();
      },
    },
  ] as const)("handles config-path and scoped plugin loads: $label", ({ run }) => {
    run();
  });

  it("only publishes plugin commands to the global registry during activating loads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = {
        id: "command-plugin",
        register(api) {
          api.registerCommand({
            name: "pair",
            description: "Pair device",
            acceptsArgs: true,
            handler: async ({ args }) => ({ text: \`paired:\${args ?? ""}\` }),
          });
        },
      };`,
      filename: "command-plugin.cjs",
      id: "command-plugin",
    });
    clearPluginCommands();

    const scoped = loadOpenClawPlugins({
      activate: false,
      cache: false,
      config: {
        plugins: {
          allow: ["command-plugin"],
          load: { paths: [plugin.file] },
        },
      },
      onlyPluginIds: ["command-plugin"],
      workspaceDir: plugin.dir,
    });

    expect(scoped.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(scoped.commands.map((entry) => entry.command.name)).toEqual(["pair"]);
    expect(getPluginCommandSpecs("telegram")).toEqual([]);

    const active = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["command-plugin"],
          load: { paths: [plugin.file] },
        },
      },
      onlyPluginIds: ["command-plugin"],
      workspaceDir: plugin.dir,
    });

    expect(active.plugins.find((entry) => entry.id === "command-plugin")?.status).toBe("loaded");
    expect(getPluginCommandSpecs()).toEqual([
      {
        acceptsArgs: true,
        description: "Pair device",
        name: "pair",
      },
    ]);

    clearPluginCommands();
  });

  it("does not register internal hooks globally during non-activating loads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = {
        id: "internal-hook-snapshot",
        register(api) {
          api.registerHook("gateway:startup", () => {}, { name: "snapshot-hook" });
        },
      };`,
      filename: "internal-hook-snapshot.cjs",
      id: "internal-hook-snapshot",
    });

    clearInternalHooks();
    const scoped = loadOpenClawPlugins({
      activate: false,
      cache: false,
      config: {
        plugins: {
          allow: ["internal-hook-snapshot"],
          load: { paths: [plugin.file] },
        },
      },
      onlyPluginIds: ["internal-hook-snapshot"],
      workspaceDir: plugin.dir,
    });

    expect(scoped.plugins.find((entry) => entry.id === "internal-hook-snapshot")?.status).toBe(
      "loaded",
    );
    expect(scoped.hooks.map((entry) => entry.entry.hook.name)).toEqual(["snapshot-hook"]);
    expect(getRegisteredEventKeys()).toEqual([]);

    clearInternalHooks();
  });

  it("replaces prior plugin hook registrations on activating reloads", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = {
        id: "internal-hook-reload",
        register(api) {
          api.registerHook(
            "gateway:startup",
            (event) => {
              event.messages.push("reload-hook-fired");
            },
            { name: "reload-hook" },
          );
        },
      };`,
      filename: "internal-hook-reload.cjs",
      id: "internal-hook-reload",
    });

    clearInternalHooks();

    const loadOptions = {
      cache: false,
      config: {
        plugins: {
          allow: ["internal-hook-reload"],
          load: { paths: [plugin.file] },
        },
      },
      onlyPluginIds: ["internal-hook-reload"],
      workspaceDir: plugin.dir,
    };

    loadOpenClawPlugins(loadOptions);
    loadOpenClawPlugins(loadOptions);

    const event = createInternalHookEvent("gateway", "startup", "gateway:startup");
    await triggerInternalHook(event);
    expect(event.messages.filter((message) => message === "reload-hook-fired")).toHaveLength(1);

    clearInternalHooks();
  });

  it("can scope bundled provider loads to deepseek without hanging", () => {
    resetPluginLoaderTestStateForTest();

    const scoped = loadOpenClawPlugins({
      activate: false,
      cache: false,
      config: {
        plugins: {
          allow: ["deepseek"],
          enabled: true,
        },
      },
      onlyPluginIds: ["deepseek"],
      pluginSdkResolution: "dist",
    });

    expect(scoped.plugins.map((entry) => entry.id)).toEqual(["deepseek"]);
    expect(scoped.plugins[0]?.status).toBe("loaded");
    expect(scoped.providers.map((entry) => entry.provider.id)).toEqual(["deepseek"]);
  });

  it("does not replace active memory plugin registries during non-activating loads", () => {
    useNoBundledPlugins();
    registerMemoryEmbeddingProvider({
      create: async () => ({ provider: null }),
      id: "active",
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      get: async () => null,
      search: async () => [],
    });
    registerMemoryPromptSection(() => ["active memory section"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["active wiki supplement"]);
    registerMemoryFlushPlanResolver(() => ({
      forceFlushTranscriptBytes: 2,
      prompt: "active",
      relativePath: "memory/active.md",
      reserveTokensFloor: 3,
      softThresholdTokens: 1,
      systemPrompt: "active",
    }));
    const activeRuntime = {
      async getMemorySearchManager() {
        return { error: "active", manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    };
    registerMemoryRuntime(activeRuntime);
    const plugin = writePlugin({
      body: `module.exports = {
        id: "snapshot-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryEmbeddingProvider({
            id: "snapshot",
            create: async () => ({ provider: null }),
          });
          api.registerMemoryPromptSection(() => ["snapshot memory section"]);
          api.registerMemoryFlushPlan(() => ({
            softThresholdTokens: 10,
            forceFlushTranscriptBytes: 20,
            reserveTokensFloor: 30,
            prompt: "snapshot",
            systemPrompt: "snapshot",
            relativePath: "memory/snapshot.md",
          }));
          api.registerMemoryRuntime({
            async getMemorySearchManager() {
              return { manager: null, error: "snapshot" };
            },
            resolveMemoryBackendConfig() {
              return { backend: "qmd", qmd: {} };
            },
          });
        },
      };`,
      filename: "snapshot-memory.cjs",
      id: "snapshot-memory",
    });

    const scoped = loadOpenClawPlugins({
      activate: false,
      cache: false,
      config: {
        plugins: {
          allow: ["snapshot-memory"],
          load: { paths: [plugin.file] },
          slots: { memory: "snapshot-memory" },
        },
      },
      onlyPluginIds: ["snapshot-memory"],
      workspaceDir: plugin.dir,
    });

    expect(scoped.plugins.find((entry) => entry.id === "snapshot-memory")?.status).toBe("loaded");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "active memory section",
      "active wiki supplement",
    ]);
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/active.md");
    expect(getMemoryRuntime()).toBe(activeRuntime);
    expect(listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["active"]);
  });

  it("clears newly-registered memory plugin registries when plugin register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = {
        id: "failing-memory",
        kind: "memory",
        register(api) {
          api.registerMemoryEmbeddingProvider({
            id: "failed",
            create: async () => ({ provider: null }),
          });
          api.registerMemoryPromptSection(() => ["stale failure section"]);
          api.registerMemoryPromptSupplement(() => ["stale failure supplement"]);
          api.registerMemoryCorpusSupplement({
            search: async () => [],
            get: async () => null,
          });
          api.registerMemoryFlushPlan(() => ({
            softThresholdTokens: 10,
            forceFlushTranscriptBytes: 20,
            reserveTokensFloor: 30,
            prompt: "failed",
            systemPrompt: "failed",
            relativePath: "memory/failed.md",
          }));
          api.registerMemoryRuntime({
            async getMemorySearchManager() {
              return { manager: null, error: "failed" };
            },
            resolveMemoryBackendConfig() {
              return { backend: "builtin" };
            },
          });
          throw new Error("memory register failed");
        },
      };`,
      filename: "failing-memory.cjs",
      id: "failing-memory",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["failing-memory"],
          load: { paths: [plugin.file] },
          slots: { memory: "failing-memory" },
        },
      },
      onlyPluginIds: ["failing-memory"],
      workspaceDir: plugin.dir,
    });

    expect(registry.plugins.find((entry) => entry.id === "failing-memory")?.status).toBe("error");
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(listMemoryCorpusSupplements()).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(listMemoryEmbeddingProviders()).toEqual([]);
  });

  it("throws when activate:false is used without cache:false", () => {
    expect(() => loadOpenClawPlugins({ activate: false })).toThrow(
      "activate:false requires cache:false",
    );
    expect(() => loadOpenClawPlugins({ activate: false, cache: true })).toThrow(
      "activate:false requires cache:false",
    );
  });

  it("re-initializes global hook runner when serving registry from cache", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      body: `module.exports = { id: "cache-hook-runner", register() {} };`,
      filename: "cache-hook-runner.cjs",
      id: "cache-hook-runner",
    });

    const options = {
      config: {
        plugins: {
          allow: ["cache-hook-runner"],
          load: { paths: [plugin.file] },
        },
      },
      workspaceDir: plugin.dir,
    };

    const first = loadOpenClawPlugins(options);
    expect(getGlobalHookRunner()).not.toBeNull();

    resetGlobalHookRunner();
    expect(getGlobalHookRunner()).toBeNull();

    const second = loadOpenClawPlugins(options);
    expect(second).toBe(first);
    expect(getGlobalHookRunner()).not.toBeNull();

    resetGlobalHookRunner();
  });

  it.each([
    {
      name: "does not reuse cached bundled plugin registries across env changes",
      pluginId: "cache-root",
      setup: () => {
        const bundledA = makeTempDir();
        const bundledB = makeTempDir();
        const pluginA = writePlugin({
          body: `module.exports = { id: "cache-root", register() {} };`,
          dir: path.join(bundledA, "cache-root"),
          filename: "index.cjs",
          id: "cache-root",
        });
        const pluginB = writePlugin({
          body: `module.exports = { id: "cache-root", register() {} };`,
          dir: path.join(bundledB, "cache-root"),
          filename: "index.cjs",
          id: "cache-root",
        });

        const options = {
          config: {
            plugins: {
              allow: ["cache-root"],
              entries: {
                "cache-root": { enabled: true },
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached load-path plugin registries across env home changes",
      pluginId: "demo",
      setup: () => {
        const homeA = makeTempDir();
        const homeB = makeTempDir();
        const stateDir = makeTempDir();
        const bundledDir = makeTempDir();
        const pluginA = writePlugin({
          body: `module.exports = { id: "demo", register() {} };`,
          dir: path.join(homeA, "plugins", "demo"),
          filename: "index.cjs",
          id: "demo",
        });
        const pluginB = writePlugin({
          body: `module.exports = { id: "demo", register() {} };`,
          dir: path.join(homeB, "plugins", "demo"),
          filename: "index.cjs",
          id: "demo",
        });

        const options = {
          config: {
            plugins: {
              allow: ["demo"],
              entries: {
                demo: { enabled: true },
              },
              load: {
                paths: ["~/plugins/demo"],
              },
            },
          },
        };

        return {
          expectedFirstSource: pluginA.file,
          expectedSecondSource: pluginB.file,
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeA,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
              },
            }),
          loadSecond: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: homeB,
                OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
                OPENCLAW_HOME: undefined,
                OPENCLAW_STATE_DIR: stateDir,
              },
            }),
        };
      },
    },
  ])("$name", ({ pluginId, setup }) => {
    const { expectedFirstSource, expectedSecondSource, loadFirst, loadSecond } = setup();
    expectCachePartitionByPluginSource({
      expectedFirstSource,
      expectedSecondSource,
      loadFirst,
      loadSecond,
      pluginId,
    });
  });

  it.each([
    {
      name: "does not reuse cached registries when env-resolved install paths change",
      setup: () => {
        useNoBundledPlugins();
        const openclawHome = makeTempDir();
        const ignoredHome = makeTempDir();
        const stateDir = makeTempDir();
        const pluginDir = path.join(openclawHome, "plugins", "tracked-install-cache");
        mkdirSafe(pluginDir);
        const plugin = writePlugin({
          body: `module.exports = { id: "tracked-install-cache", register() {} };`,
          dir: pluginDir,
          filename: "index.cjs",
          id: "tracked-install-cache",
        });

        const options = {
          config: {
            plugins: {
              allow: ["tracked-install-cache"],
              installs: {
                "tracked-install-cache": {
                  installPath: "~/plugins/tracked-install-cache",
                  source: "path" as const,
                  sourcePath: "~/plugins/tracked-install-cache",
                },
              },
              load: { paths: [plugin.file] },
            },
          },
        };

        const secondHome = makeTempDir();
        return {
          loadFirst: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: ignoredHome,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
                OPENCLAW_HOME: openclawHome,
                OPENCLAW_STATE_DIR: stateDir,
              },
            }),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              env: {
                ...process.env,
                HOME: ignoredHome,
                OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
                OPENCLAW_HOME: secondHome,
                OPENCLAW_STATE_DIR: stateDir,
              },
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across different plugin SDK resolution preferences",
      setup: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          body: `module.exports = { id: "cache-sdk-resolution", register() {} };`,
          filename: "cache-sdk-resolution.cjs",
          id: "cache-sdk-resolution",
        });

        const options = {
          config: {
            plugins: {
              allow: ["cache-sdk-resolution"],
              load: {
                paths: [plugin.file],
              },
            },
          },
          workspaceDir: plugin.dir,
        };

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              pluginSdkResolution: "workspace" as PluginSdkResolutionPreference,
            }),
        };
      },
    },
    {
      name: "does not reuse cached registries across gateway subagent binding modes",
      setup: () => {
        useNoBundledPlugins();
        const plugin = writePlugin({
          body: `module.exports = { id: "cache-gateway-shared", register() {} };`,
          filename: "cache-gateway-shared.cjs",
          id: "cache-gateway-shared",
        });

        const options = {
          config: {
            plugins: {
              allow: ["cache-gateway-shared"],
              load: {
                paths: [plugin.file],
              },
            },
          },
          workspaceDir: plugin.dir,
        };

        return {
          loadFirst: () => loadOpenClawPlugins(options),
          loadVariant: () =>
            loadOpenClawPlugins({
              ...options,
              runtimeOptions: {
                allowGatewaySubagentBinding: true,
              },
            }),
        };
      },
    },
  ])("$name", ({ setup }) => {
    expectCacheMissThenHit(setup());
  });

  it("evicts least recently used registries when the loader cache exceeds its cap", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "cache-eviction", register() {} };`,
      filename: "cache-eviction.cjs",
      id: "cache-eviction",
    });
    const previousCacheCap = __testing.maxPluginRegistryCacheEntries;
    __testing.setMaxPluginRegistryCacheEntriesForTest(4);
    const stateDirs = Array.from({ length: __testing.maxPluginRegistryCacheEntries + 1 }, () =>
      makeTempDir(),
    );

    const loadWithStateDir = (stateDir: string) =>
      loadOpenClawPlugins({
        config: {
          plugins: {
            allow: ["cache-eviction"],
            load: {
              paths: [plugin.file],
            },
          },
        },
        env: {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          OPENCLAW_STATE_DIR: stateDir,
        },
      });

    try {
      const first = loadWithStateDir(stateDirs[0] ?? makeTempDir());
      const second = loadWithStateDir(stateDirs[1] ?? makeTempDir());

      expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);

      for (const stateDir of stateDirs.slice(2)) {
        loadWithStateDir(stateDir);
      }

      expect(loadWithStateDir(stateDirs[0] ?? makeTempDir())).toBe(first);
      expect(loadWithStateDir(stateDirs[1] ?? makeTempDir())).not.toBe(second);
    } finally {
      __testing.setMaxPluginRegistryCacheEntriesForTest(previousCacheCap);
    }
  });

  it("normalizes bundled plugin env overrides against the provided env", () => {
    const bundledDir = makeTempDir();
    const homeDir = path.dirname(bundledDir);
    const override = `~/${path.basename(bundledDir)}`;
    const plugin = writePlugin({
      body: `module.exports = { id: "tilde-bundled", register() {} };`,
      dir: path.join(bundledDir, "tilde-bundled"),
      filename: "index.cjs",
      id: "tilde-bundled",
    });

    const registry = loadOpenClawPlugins({
      config: {
        plugins: {
          allow: ["tilde-bundled"],
          entries: {
            "tilde-bundled": { enabled: true },
          },
        },
      },
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_BUNDLED_PLUGINS_DIR: override,
        OPENCLAW_HOME: undefined,
      },
    });

    expect(
      fs.realpathSync(registry.plugins.find((entry) => entry.id === "tilde-bundled")?.source ?? ""),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("prefers OPENCLAW_HOME over HOME for env-expanded load paths", () => {
    const ignoredHome = makeTempDir();
    const openclawHome = makeTempDir();
    const stateDir = makeTempDir();
    const bundledDir = makeTempDir();
    const plugin = writePlugin({
      body: `module.exports = { id: "openclaw-home-demo", register() {} };`,
      dir: path.join(openclawHome, "plugins", "openclaw-home-demo"),
      filename: "index.cjs",
      id: "openclaw-home-demo",
    });

    const registry = loadOpenClawPlugins({
      config: {
        plugins: {
          allow: ["openclaw-home-demo"],
          entries: {
            "openclaw-home-demo": { enabled: true },
          },
          load: {
            paths: ["~/plugins/openclaw-home-demo"],
          },
        },
      },
      env: {
        ...process.env,
        HOME: ignoredHome,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_STATE_DIR: stateDir,
      },
    });

    expect(
      fs.realpathSync(
        registry.plugins.find((entry) => entry.id === "openclaw-home-demo")?.source ?? "",
      ),
    ).toBe(fs.realpathSync(plugin.file));
  });

  it("loads plugins when source and root differ only by realpath alias", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "alias-safe", register() {} };`,
      filename: "alias-safe.cjs",
      id: "alias-safe",
    });
    const realRoot = fs.realpathSync(plugin.dir);
    if (realRoot === plugin.dir) {
      return;
    }

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["alias-safe"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "alias-safe");
    expect(loaded?.status).toBe("loaded");
  });

  it("denylist disables plugins even if allowed", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "blocked", register() {} };`,
      id: "blocked",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["blocked"],
        deny: ["blocked"],
      },
    });

    const blocked = registry.plugins.find((entry) => entry.id === "blocked");
    expect(blocked?.status).toBe("disabled");
  });

  it("fails fast on invalid plugin config", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "configurable", register() {} };`,
      filename: "configurable.cjs",
      id: "configurable",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        entries: {
          configurable: {
            config: "nope" as unknown as Record<string, unknown>,
          },
        },
      },
    });

    const configurable = registry.plugins.find((entry) => entry.id === "configurable");
    expect(configurable?.status).toBe("error");
    expect(registry.diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("throws when strict plugin loading sees plugin errors", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "configurable", register() {} };`,
      filename: "configurable.cjs",
      id: "configurable",
    });

    expect(() =>
      loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            allow: ["configurable"],
            enabled: true,
            entries: {
              configurable: {
                config: "nope" as unknown as Record<string, unknown>,
                enabled: true,
              },
            },
            load: { paths: [plugin.file] },
          },
        },
        throwOnLoadError: true,
      }),
    ).toThrow("plugin load failed: configurable: invalid config: <root>: must be object");
  });

  it("fails when plugin export id mismatches manifest id", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "export-id", register() {} };`,
      filename: "manifest-id.cjs",
      id: "manifest-id",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["manifest-id"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "manifest-id");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toBe(
      'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
    );
    expect(
      registry.diagnostics.some(
        (entry) =>
          entry.level === "error" &&
          entry.pluginId === "manifest-id" &&
          entry.message ===
            'plugin id mismatch (config uses "manifest-id", export uses "export-id")',
      ),
    ).toBe(true);
  });

  it("handles single-plugin channel, context engine, and cli validation", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const channel = registry.channels.find((entry) => entry.plugin.id === "demo");
          expect(channel).toBeDefined();
        },
        body: `module.exports = { id: "channel-demo", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo",
        selectionLabel: "Demo",
        docsPath: "/channels/demo",
        blurb: "demo channel"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
        label: "registers channel plugins",
        pluginId: "channel-demo",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.channels.filter((entry) => entry.plugin.id === "demo")).toHaveLength(1);
          expectRegistryErrorDiagnostic({
            message: "channel already registered: demo (channel-dup)",
            pluginId: "channel-dup",
            registry,
          });
        },
        body: `module.exports = { id: "channel-dup", register(api) {
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo Override",
        selectionLabel: "Demo Override",
        docsPath: "/channels/demo-override",
        blurb: "override"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
  api.registerChannel({
    plugin: {
      id: "demo",
      meta: {
        id: "demo",
        label: "Demo Duplicate",
        selectionLabel: "Demo Duplicate",
        docsPath: "/channels/demo-duplicate",
        blurb: "duplicate"
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" })
      },
      outbound: { deliveryMode: "direct" }
    }
  });
} };`,
        label: "rejects duplicate channel ids during plugin registration",
        pluginId: "channel-dup",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectRegistryErrorDiagnostic({
            message: "context engine id reserved by core: legacy",
            pluginId: "context-engine-core-collision",
            registry,
          });
        },
        body: `module.exports = { id: "context-engine-core-collision", register(api) {
  api.registerContextEngine("legacy", () => ({}));
} };`,
        label: "rejects plugin context engine ids reserved by core",
        pluginId: "context-engine-core-collision",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars).toHaveLength(0);
          expectRegistryErrorDiagnostic({
            message: "cli registration missing explicit commands metadata",
            pluginId: "cli-missing-metadata",
            registry,
          });
        },
        body: `module.exports = { id: "cli-missing-metadata", register(api) {
  api.registerCli(() => {});
} };`,
        label: "requires plugin CLI registrars to declare explicit command roots",
        pluginId: "cli-missing-metadata",
      },
    ] as const;

    runSinglePluginRegistryScenarios(scenarios);
  });

  it("registers plugin http routes", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        assert: expectRegisteredHttpRoute,
        expectedAuth: "gateway",
        expectedMatch: "exact",
        expectedPath: "/demo",
        label: "defaults exact match",
        pluginId: "http-route-demo",
        routeOptions:
          '{ path: "/demo", auth: "gateway", handler: async (_req, res) => { res.statusCode = 200; res.end("ok"); } }',
      },
      {
        assert: expectRegisteredHttpRoute,
        expectedAuth: "plugin",
        expectedMatch: "prefix",
        expectedPath: "/webhook",
        label: "keeps explicit auth and match options",
        pluginId: "http-demo",
        routeOptions:
          '{ path: "/webhook", auth: "plugin", match: "prefix", handler: async () => false }',
      },
    ] as const;

    runSinglePluginRegistryScenarios(
      scenarios.map((scenario) => ({
        ...scenario,
        body: `module.exports = { id: "${scenario.pluginId}", register(api) {
  api.registerHttpRoute(${scenario.routeOptions});
} };`,
      })),
    );
  });

  it("rejects duplicate plugin registrations", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        assert: expectDuplicateRegistrationResult,
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerHook("gateway:startup", () => {}, { name: "shared-hook" });
} };`,
        duplicateMessage: "hook already registered: shared-hook (hook-owner-a)",
        label: "plugin-visible hook names",
        ownerA: "hook-owner-a",
        ownerB: "hook-owner-b",
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.hooks.filter((entry) => entry.entry.hook.name === "shared-hook").length,
      },
      {
        assert: expectDuplicateRegistrationResult,
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerService({ id: "shared-service", start() {} });
} };`,
        duplicateMessage: "service already registered: shared-service (service-owner-a)",
        label: "plugin service ids",
        ownerA: "service-owner-a",
        ownerB: "service-owner-b",
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.services.filter((entry) => entry.service.id === "shared-service").length,
      },
      {
        assert: expectDuplicateRegistrationResult,
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerContextEngine("shared-context-engine-loader-test", () => ({}));
} };`,
        duplicateMessage:
          "context engine already registered: shared-context-engine-loader-test (plugin:context-engine-owner-a)",
        label: "plugin context engine ids",
        ownerA: "context-engine-owner-a",
        ownerB: "context-engine-owner-b",
        selectCount: () => 1,
      },
      {
        assert: expectDuplicateRegistrationResult,
        assertPrimaryOwner: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(registry.cliRegistrars[0]?.pluginId).toBe("cli-owner-a");
        },
        buildBody: (ownerId: string) => `module.exports = { id: "${ownerId}", register(api) {
  api.registerCli(() => {}, { commands: ["shared-cli"] });
} };`,
        duplicateMessage: "cli command already registered: shared-cli (cli-owner-a)",
        label: "plugin CLI command roots",
        ownerA: "cli-owner-a",
        ownerB: "cli-owner-b",
        selectCount: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
          registry.cliRegistrars.length,
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => {
      const first = writePlugin({
        body: scenario.buildBody(scenario.ownerA),
        filename: `${scenario.ownerA}.cjs`,
        id: scenario.ownerA,
      });
      const second = writePlugin({
        body: scenario.buildBody(scenario.ownerB),
        filename: `${scenario.ownerB}.cjs`,
        id: scenario.ownerB,
      });
      return loadRegistryFromAllowedPlugins([first, second]);
    });
  });

  it("allows the same plugin to register the same service id twice", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "service-owner-self", register(api) {
  api.registerService({ id: "shared-service", start() {} });
  api.registerService({ id: "shared-service", start() {} });
} };`,
      filename: "service-owner-self.cjs",
      id: "service-owner-self",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["service-owner-self"],
      },
    });

    expect(registry.services.filter((entry) => entry.service.id === "shared-service")).toHaveLength(
      1,
    );
    expect(
      registry.diagnostics.some((diag) =>
        String(diag.message).includes("service already registered: shared-service"),
      ),
    ).toBe(false);
  });

  it("rewrites removed registerHttpHandler failures into migration diagnostics", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "http-handler-legacy", register(api) {
  api.registerHttpHandler({ path: "/legacy", handler: async () => true });
} };`,
      filename: "http-handler-legacy.cjs",
      id: "http-handler-legacy",
    });

    const errors: string[] = [];
    const registry = loadRegistryFromSinglePlugin({
      options: {
        logger: createErrorLogger(errors),
      },
      plugin,
      pluginConfig: {
        allow: ["http-handler-legacy"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-legacy");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).toContain("api.registerHttpHandler(...) was removed");
    expect(loaded?.error).toContain("api.registerHttpRoute(...)");
    expect(loaded?.error).toContain("registerPluginHttpRoute(...)");
    expect(
      registry.diagnostics.some((diag) =>
        String(diag.message).includes("api.registerHttpHandler(...) was removed"),
      ),
    ).toBe(true);
    expect(errors.some((entry) => entry.includes("api.registerHttpHandler(...) was removed"))).toBe(
      true,
    );
  });

  it("does not rewrite unrelated registerHttpHandler helper failures", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "http-handler-local-helper", register() {
  const registerHttpHandler = undefined;
  registerHttpHandler();
} };`,
      filename: "http-handler-local-helper.cjs",
      id: "http-handler-local-helper",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["http-handler-local-helper"],
      },
    });

    const loaded = registry.plugins.find((entry) => entry.id === "http-handler-local-helper");
    expect(loaded?.status).toBe("error");
    expect(loaded?.error).not.toContain("api.registerHttpHandler(...) was removed");
  });

  it("enforces plugin http route validation and conflict rules", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expect(
            registry.httpRoutes.find((entry) => entry.pluginId === "http-route-missing-auth"),
          ).toBeUndefined();
          expect(
            registry.diagnostics.some((diag) =>
              String(diag.message).includes("http route registration missing or invalid auth"),
            ),
          ).toBe(true);
        },
        buildPlugins: () => [
          writePlugin({
            body: `module.exports = { id: "http-route-missing-auth", register(api) {
  api.registerHttpRoute({ path: "/demo", handler: async () => true });
} };`,
            filename: "http-route-missing-auth.cjs",
            id: "http-route-missing-auth",
          }),
        ],
        label: "missing auth is rejected",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-replace-self",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/demo");
          expect(registry.diagnostics).toEqual([]);
        },
        buildPlugins: () => [
          writePlugin({
            body: `module.exports = { id: "http-route-replace-self", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
            filename: "http-route-replace-self.cjs",
            id: "http-route-replace-self",
          }),
        ],
        label: "same plugin can replace its own route",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const route = registry.httpRoutes.find((entry) => entry.path === "/demo");
          expect(route?.pluginId).toBe("http-route-owner-a");
          expect(
            registry.diagnostics.some((diag) =>
              String(diag.message).includes("http route replacement rejected"),
            ),
          ).toBe(true);
        },
        buildPlugins: () => [
          writePlugin({
            body: `module.exports = { id: "http-route-owner-a", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", handler: async () => false });
} };`,
            filename: "http-route-owner-a.cjs",
            id: "http-route-owner-a",
          }),
          writePlugin({
            body: `module.exports = { id: "http-route-owner-b", register(api) {
  api.registerHttpRoute({ path: "/demo", auth: "plugin", replaceExisting: true, handler: async () => true });
} };`,
            filename: "http-route-owner-b.cjs",
            id: "http-route-owner-b",
          }),
        ],
        label: "cross-plugin replaceExisting is rejected",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap",
          );
          expect(routes).toHaveLength(1);
          expect(routes[0]?.path).toBe("/plugin/secure");
          expect(
            registry.diagnostics.some((diag) =>
              String(diag.message).includes("http route overlap rejected"),
            ),
          ).toBe(true);
        },
        buildPlugins: () => [
          writePlugin({
            body: `module.exports = { id: "http-route-overlap", register(api) {
  api.registerHttpRoute({ path: "/plugin/secure", auth: "gateway", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/secure/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
            filename: "http-route-overlap.cjs",
            id: "http-route-overlap",
          }),
        ],
        label: "mixed-auth overlaps are rejected",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const routes = registry.httpRoutes.filter(
            (entry) => entry.pluginId === "http-route-overlap-same-auth",
          );
          expect(routes).toHaveLength(2);
          expect(registry.diagnostics).toEqual([]);
        },
        buildPlugins: () => [
          writePlugin({
            body: `module.exports = { id: "http-route-overlap-same-auth", register(api) {
  api.registerHttpRoute({ path: "/plugin/public", auth: "plugin", match: "prefix", handler: async () => true });
  api.registerHttpRoute({ path: "/plugin/public/report", auth: "plugin", match: "exact", handler: async () => true });
} };`,
            filename: "http-route-overlap-same-auth.cjs",
            id: "http-route-overlap-same-auth",
          }),
        ],
        label: "same-auth overlaps are allowed",
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) =>
      loadRegistryFromScenarioPlugins(scenario.buildPlugins()),
    );
  });

  it("respects explicit disable in config", () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
    const plugin = writePlugin({
      body: `module.exports = { id: "config-disable", register() {} };`,
      id: "config-disable",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          entries: {
            "config-disable": { enabled: false },
          },
          load: { paths: [plugin.file] },
        },
      },
    });

    const disabled = registry.plugins.find((entry) => entry.id === "config-disable");
    expect(disabled?.status).toBe("disabled");
  });

  it("does not treat manifest channel ids as scoped plugin id matches", () => {
    useNoBundledPlugins();
    const target = writePlugin({
      body: `module.exports = { id: "target-plugin", register() {} };`,
      filename: "target-plugin.cjs",
      id: "target-plugin",
    });
    const unrelated = writePlugin({
      body: `module.exports = { id: "unrelated-plugin", register() { throw new Error("unrelated plugin should not load"); } };`,
      filename: "unrelated-plugin.cjs",
      id: "unrelated-plugin",
    });
    fs.writeFileSync(
      path.join(unrelated.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          channels: ["target-plugin"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
          id: "unrelated-plugin",
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["target-plugin", "unrelated-plugin"],
          entries: {
            "target-plugin": { enabled: true },
            "unrelated-plugin": { enabled: true },
          },
          load: { paths: [target.file, unrelated.file] },
        },
      },
      onlyPluginIds: ["target-plugin"],
    });

    expect(registry.plugins.map((entry) => entry.id)).toEqual(["target-plugin"]);
  });

  it("only setup-loads a disabled channel plugin when the caller scopes to the selected plugin", () => {
    useNoBundledPlugins();
    const marker = path.join(makeTempDir(), "lazy-channel-imported.txt");
    const plugin = writePlugin({
      body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded", "utf-8");
module.exports = {
  id: "lazy-channel-plugin",
  register(api) {
    api.registerChannel({
      plugin: {
        id: "lazy-channel",
        meta: {
          id: "lazy-channel",
          label: "Lazy Channel",
          selectionLabel: "Lazy Channel",
          docsPath: "/channels/lazy-channel",
          blurb: "lazy test channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
};`,
      filename: "lazy-channel.cjs",
      id: "lazy-channel-plugin",
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          channels: ["lazy-channel"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
          id: "lazy-channel-plugin",
        },
        null,
        2,
      ),
      "utf8",
    );
    const config = {
      plugins: {
        allow: ["lazy-channel-plugin"],
        entries: {
          "lazy-channel-plugin": { enabled: false },
        },
        load: { paths: [plugin.file] },
      },
    };

    const registry = loadOpenClawPlugins({
      cache: false,
      config,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(registry.channelSetups).toHaveLength(0);
    expect(registry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status).toBe(
      "disabled",
    );

    const broadSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(broadSetupRegistry.channelSetups).toHaveLength(0);
    expect(broadSetupRegistry.channels).toHaveLength(0);
    expect(
      broadSetupRegistry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status,
    ).toBe("disabled");

    const scopedSetupRegistry = loadOpenClawPlugins({
      cache: false,
      config,
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["lazy-channel-plugin"],
    });

    expect(fs.existsSync(marker)).toBe(true);
    expect(scopedSetupRegistry.channelSetups).toHaveLength(1);
    expect(scopedSetupRegistry.channels).toHaveLength(0);
    expect(
      scopedSetupRegistry.plugins.find((entry) => entry.id === "lazy-channel-plugin")?.status,
    ).toBe("disabled");
  });

  it.each([
    {
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 0,
      fixture: {
        configured: false,
        fullBlurb: "full entry should not run in setup-only mode",
        id: "setup-entry-test",
        label: "Setup Entry Test",
        packageName: "@openclaw/setup-entry-test",
        setupBlurb: "setup entry",
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              allow: ["setup-entry-test"],
              entries: {
                "setup-entry-test": { enabled: false },
              },
              load: { paths: [pluginDir] },
            },
          },
          includeSetupOnlyChannelPlugins: true,
          onlyPluginIds: ["setup-entry-test"],
        }),
      name: "uses package setupEntry for selected setup-only channel loads",
    },
    {
      expectFullLoaded: false,
      expectSetupLoaded: true,
      expectedChannels: 1,
      fixture: {
        configured: false,
        fullBlurb: "full entry should not run while unconfigured",
        id: "setup-runtime-test",
        label: "Setup Runtime Test",
        packageName: "@openclaw/setup-runtime-test",
        setupBlurb: "setup runtime",
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              allow: ["setup-runtime-test"],
              load: { paths: [pluginDir] },
            },
          },
        }),
      name: "uses package setupEntry for enabled but unconfigured channel loads",
    },
    {
      expectFullLoaded: true,
      expectSetupLoaded: false,
      expectedChannels: 1,
      fixture: {
        configured: true,
        fullBlurb: "full entry should still load without explicit startup opt-in",
        id: "setup-runtime-not-preferred-test",
        label: "Setup Runtime Not Preferred Test",
        packageName: "@openclaw/setup-runtime-not-preferred-test",
        setupBlurb: "setup runtime not preferred",
      },
      load: ({ pluginDir }: { pluginDir: string }) =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            channels: {
              "setup-runtime-not-preferred-test": {
                enabled: true,
                token: "configured",
              },
            },
            plugins: {
              allow: ["setup-runtime-not-preferred-test"],
              load: { paths: [pluginDir] },
            },
          },
          preferSetupRuntimeForChannelPlugins: true,
        }),
      name: "does not prefer setupEntry for configured channel loads without startup opt-in",
    },
  ])("$name", ({ fixture, load, expectFullLoaded, expectSetupLoaded, expectedChannels }) => {
    const built = createSetupEntryChannelPluginFixture(fixture);
    const registry = load({ pluginDir: built.pluginDir });

    expect(fs.existsSync(built.fullMarker)).toBe(expectFullLoaded);
    expect(fs.existsSync(built.setupMarker)).toBe(expectSetupLoaded);
    expect(registry.channelSetups).toHaveLength(1);
    expect(registry.channels).toHaveLength(expectedChannels);
  });

  it("prefers setupEntry for configured channel loads during startup when opted in", () => {
    expect(
      __testing.shouldLoadChannelPluginInSetupRuntime({
        cfg: {
          channels: {
            "setup-runtime-preferred-test": {
              enabled: true,
              token: "configured",
            },
          },
        },
        env: {},
        manifestChannels: ["setup-runtime-preferred-test"],
        preferSetupRuntimeForChannelPlugins: true,
        setupSource: "./setup-entry.cjs",
        startupDeferConfiguredChannelFullLoadUntilAfterListen: true,
      }),
    ).toBe(true);
  });

  it("blocks before_prompt_build but preserves legacy model overrides when prompt injection is disabled", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "hook-policy", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
  api.on("before_agent_start", () => ({
    prependContext: "legacy",
    modelOverride: "demo-legacy-model",
    providerOverride: "demo-legacy-provider",
  }));
  api.on("before_model_resolve", () => ({ providerOverride: "demo-explicit-provider" }));
} };`,
      filename: "hook-policy.cjs",
      id: "hook-policy",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy"],
        entries: {
          "hook-policy": {
            hooks: {
              allowPromptInjection: false,
            },
          },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-policy")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_agent_start",
      "before_model_resolve",
    ]);
    const runner = createHookRunner(registry);
    const legacyResult = await runner.runBeforeAgentStart({ messages: [], prompt: "hello" }, {});
    expect(legacyResult).toEqual({
      modelOverride: "demo-legacy-model",
      providerOverride: "demo-legacy-provider",
    });
    const blockedDiagnostics = registry.diagnostics.filter((diag) =>
      String(diag.message).includes(
        "blocked by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(blockedDiagnostics).toHaveLength(1);
    const constrainedDiagnostics = registry.diagnostics.filter((diag) =>
      String(diag.message).includes(
        "prompt fields constrained by plugins.entries.hook-policy.hooks.allowPromptInjection=false",
      ),
    );
    expect(constrainedDiagnostics).toHaveLength(1);
  });

  it("keeps prompt-injection typed hooks enabled by default", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "hook-policy-default", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "prepend" }));
  api.on("before_agent_start", () => ({ prependContext: "legacy" }));
} };`,
      filename: "hook-policy-default.cjs",
      id: "hook-policy-default",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-policy-default"],
      },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual([
      "before_prompt_build",
      "before_agent_start",
    ]);
  });

  it("ignores unknown typed hooks from plugins and keeps loading", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = { id: "hook-unknown", register(api) {
  api.on("totally_unknown_hook_name", () => ({ foo: "bar" }));
  api.on(123, () => ({ foo: "baz" }));
  api.on("before_model_resolve", () => ({ providerOverride: "demo-provider" }));
} };`,
      filename: "hook-unknown.cjs",
      id: "hook-unknown",
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["hook-unknown"],
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "hook-unknown")?.status).toBe("loaded");
    expect(registry.typedHooks.map((entry) => entry.hookName)).toEqual(["before_model_resolve"]);
    const unknownHookDiagnostics = registry.diagnostics.filter((diag) =>
      String(diag.message).includes('unknown typed hook "'),
    );
    expect(unknownHookDiagnostics).toHaveLength(2);
    expect(
      unknownHookDiagnostics.some((diag) =>
        String(diag.message).includes('unknown typed hook "totally_unknown_hook_name" ignored'),
      ),
    ).toBe(true);
    expect(
      unknownHookDiagnostics.some((diag) =>
        String(diag.message).includes('unknown typed hook "123" ignored'),
      ),
    ).toBe(true);
  });

  it("enforces memory slot loading rules", () => {
    const scenarios = [
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(b?.status).toBe("loaded");
          expect(a?.status).toBe("disabled");
        },
        label: "enforces memory slot selection",
        loadRegistry: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const memoryA = writePlugin({
            body: memoryPluginBody("memory-a"),
            id: "memory-a",
          });
          const memoryB = writePlugin({
            body: memoryPluginBody("memory-b"),
            id: "memory-b",
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [memoryA.file, memoryB.file] },
                slots: { memory: "memory-b" },
              },
            },
          });
        },
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const a = registry.plugins.find((entry) => entry.id === "memory-a");
          const b = registry.plugins.find((entry) => entry.id === "memory-b");
          expect(a?.status).toBe("disabled");
          expect(String(a?.error ?? "")).toContain('memory slot set to "memory-b"');
          expect(b?.status).toBe("loaded");
        },
        label: "skips importing bundled memory plugins that are disabled by memory slot",
        loadRegistry: () => {
          const bundledDir = makeTempDir();
          const memoryADir = path.join(bundledDir, "memory-a");
          const memoryBDir = path.join(bundledDir, "memory-b");
          mkdirSafe(memoryADir);
          mkdirSafe(memoryBDir);
          writePlugin({
            body: `throw new Error("memory-a should not be imported when slot selects memory-b");`,
            dir: memoryADir,
            filename: "index.cjs",
            id: "memory-a",
          });
          writePlugin({
            body: memoryPluginBody("memory-b"),
            dir: memoryBDir,
            filename: "index.cjs",
            id: "memory-b",
          });
          fs.writeFileSync(
            path.join(memoryADir, "openclaw.plugin.json"),
            JSON.stringify(
              {
                configSchema: EMPTY_PLUGIN_SCHEMA,
                id: "memory-a",
                kind: "memory",
              },
              null,
              2,
            ),
            "utf8",
          );
          fs.writeFileSync(
            path.join(memoryBDir, "openclaw.plugin.json"),
            JSON.stringify(
              {
                configSchema: EMPTY_PLUGIN_SCHEMA,
                id: "memory-b",
                kind: "memory",
              },
              null,
              2,
            ),
            "utf8",
          );
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["memory-a", "memory-b"],
                entries: {
                  "memory-a": { enabled: true },
                  "memory-b": { enabled: true },
                },
                slots: { memory: "memory-b" },
              },
            },
          });
        },
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          const entry = registry.plugins.find((item) => item.id === "memory-off");
          expect(entry?.status).toBe("disabled");
        },
        label: "disables memory plugins when slot is none",
        loadRegistry: () => {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
          const memory = writePlugin({
            body: memoryPluginBody("memory-off"),
            id: "memory-off",
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [memory.file] },
                slots: { memory: "none" },
              },
            },
          });
        },
      },
    ] as const;

    runRegistryScenarios(scenarios, ({ loadRegistry }) => loadRegistry());
  });

  it("resolves duplicate plugin ids by source precedence", () => {
    const scenarios = [
      {
        assert: expectPluginSourcePrecedence,
        bundledFilename: "shadow.cjs",
        expectedDisabledOrigin: "bundled",
        expectedLoadedOrigin: "config",
        label: "config load overrides bundled",
        loadRegistry: () => {
          writeBundledPlugin({
            body: simplePluginBody("shadow"),
            filename: "shadow.cjs",
            id: "shadow",
          });

          const override = writePlugin({
            body: simplePluginBody("shadow"),
            id: "shadow",
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                entries: {
                  shadow: { enabled: true },
                },
                load: { paths: [override.file] },
              },
            },
          });
        },
        pluginId: "shadow",
      },
      {
        assert: expectPluginSourcePrecedence,
        bundledFilename: "index.cjs",
        expectedDisabledError: "overridden by bundled plugin",
        expectedDisabledOrigin: "global",
        expectedLoadedOrigin: "bundled",
        label: "bundled beats auto-discovered global duplicate",
        loadRegistry: () => {
          writeBundledPlugin({
            body: simplePluginBody("demo-bundled-duplicate"),
            id: "demo-bundled-duplicate",
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "demo-bundled-duplicate");
            mkdirSafe(globalDir);
            writePlugin({
              body: simplePluginBody("demo-bundled-duplicate"),
              dir: globalDir,
              filename: "index.cjs",
              id: "demo-bundled-duplicate",
            });

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["demo-bundled-duplicate"],
                  entries: {
                    "demo-bundled-duplicate": { enabled: true },
                  },
                },
              },
            });
          });
        },
        pluginId: "demo-bundled-duplicate",
      },
      {
        assert: expectPluginSourcePrecedence,
        bundledFilename: "index.cjs",
        expectedDisabledError: "overridden by global plugin",
        expectedDisabledOrigin: "bundled",
        expectedLoadedOrigin: "global",
        label: "installed global beats bundled duplicate",
        loadRegistry: () => {
          writeBundledPlugin({
            body: simplePluginBody("demo-installed-duplicate"),
            id: "demo-installed-duplicate",
          });
          return withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "demo-installed-duplicate");
            mkdirSafe(globalDir);
            writePlugin({
              body: simplePluginBody("demo-installed-duplicate"),
              dir: globalDir,
              filename: "index.cjs",
              id: "demo-installed-duplicate",
            });

            return loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["demo-installed-duplicate"],
                  entries: {
                    "demo-installed-duplicate": { enabled: true },
                  },
                  installs: {
                    "demo-installed-duplicate": {
                      installPath: globalDir,
                      source: "npm",
                    },
                  },
                },
              },
            });
          });
        },
        pluginId: "demo-installed-duplicate",
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => scenario.loadRegistry());
  });

  it("warns about open allowlists only for auto-discovered plugins", () => {
    useNoBundledPlugins();
    clearPluginLoaderCache();
    const scenarios = [
      {
        expectedWarnings: 0,
        label: "explicit config path stays quiet",
        loadRegistry: (warnings: string[]) => {
          const plugin = writePlugin({
            body: simplePluginBody("warn-open-allow-config"),
            id: "warn-open-allow-config",
          });
          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                load: { paths: [plugin.file] },
              },
            },
            logger: createWarningLogger(warnings),
          });
        },
        loads: 1,
        pluginId: "warn-open-allow-config",
      },
      {
        expectedWarnings: 1,
        label: "workspace discovery warns once",
        loadRegistry: (() => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "warn-open-allow-workspace",
          });
          return (warnings: string[]) =>
            loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  enabled: true,
                },
              },
              logger: createWarningLogger(warnings),
              workspaceDir,
            });
        })(),
        loads: 2,
        pluginId: "warn-open-allow-workspace",
      },
    ] as const;

    runScenarioCases(scenarios, (scenario) => {
      const warnings: string[] = [];

      for (let index = 0; index < scenario.loads; index += 1) {
        scenario.loadRegistry(warnings);
      }

      expectOpenAllowWarnings({
        expectedWarnings: scenario.expectedWarnings,
        label: scenario.label,
        pluginId: scenario.pluginId,
        warnings,
      });
    });
  });

  it("handles workspace-discovered plugins according to trust and precedence", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectPluginOriginAndStatus({
            errorIncludes: "workspace plugin (disabled by default)",
            label: "untrusted workspace plugins stay disabled",
            origin: "workspace",
            pluginId: "workspace-helper",
            registry,
            status: "disabled",
          });
        },
        label: "untrusted workspace plugins stay disabled",
        loadRegistry: () => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "workspace-helper",
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                enabled: true,
              },
            },
            workspaceDir,
          });
        },
        pluginId: "workspace-helper",
      },
      {
        assert: (registry: ReturnType<typeof loadOpenClawPlugins>) => {
          expectPluginOriginAndStatus({
            label: "trusted workspace plugins load",
            origin: "workspace",
            pluginId: "workspace-helper",
            registry,
            status: "loaded",
          });
        },
        label: "trusted workspace plugins load",
        loadRegistry: () => {
          const { workspaceDir } = writeWorkspacePlugin({
            id: "workspace-helper",
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["workspace-helper"],
                enabled: true,
              },
            },
            workspaceDir,
          });
        },
        pluginId: "workspace-helper",
      },
      {
        assert: (registry: PluginRegistry) => {
          expectPluginSourcePrecedence(registry, {
            expectedDisabledError: "overridden by bundled plugin",
            expectedDisabledOrigin: "workspace",
            expectedLoadedOrigin: "bundled",
            label: "bundled plugins stay ahead of trusted workspace duplicates",
            pluginId: "shadowed",
          });
        },
        expectedDisabledError: "overridden by bundled plugin",
        expectedDisabledOrigin: "workspace",
        expectedLoadedOrigin: "bundled",
        label: "bundled plugins stay ahead of trusted workspace duplicates",
        loadRegistry: () => {
          writeBundledPlugin({
            id: "shadowed",
          });
          const { workspaceDir } = writeWorkspacePlugin({
            id: "shadowed",
          });

          return loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["shadowed"],
                enabled: true,
                entries: {
                  shadowed: { enabled: true },
                },
              },
            },
            workspaceDir,
          });
        },
        pluginId: "shadowed",
      },
    ] as const;

    runRegistryScenarios(scenarios, (scenario) => scenario.loadRegistry());
  });

  it("loads bundled plugins when manifest metadata opts into default enablement", () => {
    const { bundledDir, plugin } = writeBundledPlugin({
      body: simplePluginBody("profile-aware"),
      id: "profile-aware",
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          configSchema: EMPTY_PLUGIN_SCHEMA,
          enabledByDefault: true,
          id: "profile-aware",
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
        },
      },
      workspaceDir: bundledDir,
    });

    const bundledPlugin = registry.plugins.find((entry) => entry.id === "profile-aware");
    expect(bundledPlugin?.origin).toBe("bundled");
    expect(bundledPlugin?.status).toBe("loaded");
  });

  it("keeps scoped and unscoped plugin ids distinct", () => {
    useNoBundledPlugins();
    const scoped = writePlugin({
      body: simplePluginBody("@team/shadowed"),
      filename: "scoped.cjs",
      id: "@team/shadowed",
    });
    const unscoped = writePlugin({
      body: simplePluginBody("shadowed"),
      filename: "unscoped.cjs",
      id: "shadowed",
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["@team/shadowed", "shadowed"],
          load: { paths: [scoped.file, unscoped.file] },
        },
      },
    });

    expect(registry.plugins.find((entry) => entry.id === "@team/shadowed")?.status).toBe("loaded");
    expect(registry.plugins.find((entry) => entry.id === "shadowed")?.status).toBe("loaded");
    expect(
      registry.diagnostics.some((diag) => String(diag.message).includes("duplicate plugin id")),
    ).toBe(false);
  });

  it("evaluates load-path provenance warnings", () => {
    useNoBundledPlugins();
    const scenarios = [
      {
        label: "does not warn when loaded non-bundled plugin is in plugins.allow",
        loadRegistry: () =>
          withStateDir((stateDir) => {
            const globalDir = path.join(stateDir, "extensions", "rogue");
            mkdirSafe(globalDir);
            writePlugin({
              body: simplePluginBody("rogue"),
              dir: globalDir,
              filename: "index.cjs",
              id: "rogue",
            });

            const warnings: string[] = [];
            const registry = loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  allow: ["rogue"],
                },
              },
              logger: createWarningLogger(warnings),
            });

            return { expectWarning: false, pluginId: "rogue", registry, warnings };
          }),
      },
      {
        label: "warns when loaded non-bundled plugin has no provenance and no allowlist is set",
        loadRegistry: () => {
          const stateDir = makeTempDir();
          return withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
            const globalDir = path.join(stateDir, "extensions", "rogue");
            mkdirSafe(globalDir);
            writePlugin({
              body: `module.exports = { id: "rogue", register() {} };`,
              dir: globalDir,
              filename: "index.cjs",
              id: "rogue",
            });

            const warnings: string[] = [];
            const registry = loadOpenClawPlugins({
              cache: false,
              config: {
                plugins: {
                  enabled: true,
                },
              },
              logger: createWarningLogger(warnings),
            });

            return { expectWarning: true, pluginId: "rogue", registry, warnings };
          });
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved load paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-load-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: [plugin.id],
                load: { paths: ["~/plugins/tracked-load-path"] },
              },
            },
            env,
            logger: createWarningLogger(warnings),
          });

          return {
            expectWarning: false,
            expectedSource: plugin.file,
            pluginId: plugin.id,
            registry,
            warnings,
          };
        },
      },
      {
        label: "does not warn about missing provenance for env-resolved install paths",
        loadRegistry: () => {
          const { plugin, env } = createEnvResolvedPluginFixture("tracked-install-path");
          const warnings: string[] = [];
          const registry = loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: [plugin.id],
                installs: {
                  [plugin.id]: {
                    installPath: `~/plugins/${plugin.id}`,
                    source: "path",
                    sourcePath: `~/plugins/${plugin.id}`,
                  },
                },
                load: { paths: [plugin.file] },
              },
            },
            env,
            logger: createWarningLogger(warnings),
          });

          return {
            expectWarning: false,
            expectedSource: plugin.file,
            pluginId: plugin.id,
            registry,
            warnings,
          };
        },
      },
    ] as const;

    runScenarioCases(scenarios, (scenario) => {
      const loadedScenario = scenario.loadRegistry();
      const expectedSource =
        "expectedSource" in loadedScenario && typeof loadedScenario.expectedSource === "string"
          ? loadedScenario.expectedSource
          : undefined;
      expectLoadedPluginProvenance({
        scenario,
        ...loadedScenario,
        expectedSource,
      });
    });
  });

  it.each([
    {
      id: "symlinked",
      linkKind: "symlink" as const,
      name: "rejects plugin entry files that escape plugin root via symlink",
    },
    {
      id: "hardlinked",
      linkKind: "hardlink" as const,
      name: "rejects plugin entry files that escape plugin root via hardlink",
      skip: process.platform === "win32",
    },
  ])("$name", ({ id, linkKind, skip }) => {
    if (skip) {
      return;
    }
    expectEscapingEntryRejected({
      id,
      linkKind,
      sourceBody: `module.exports = { id: "${id}", register() { throw new Error("should not run"); } };`,
    });
  });

  it("allows bundled plugin entry files that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const bundledDir = makeTempDir();
    const pluginDir = path.join(bundledDir, "hardlinked-bundled");
    mkdirSafe(pluginDir);

    const outsideDir = makeTempDir();
    const outsideEntry = path.join(outsideDir, "outside.cjs");
    fs.writeFileSync(
      outsideEntry,
      'module.exports = { id: "hardlinked-bundled", register() {} };',
      "utf8",
    );
    const plugin = writePlugin({
      body: 'module.exports = { id: "hardlinked-bundled", register() {} };',
      dir: pluginDir,
      filename: "index.cjs",
      id: "hardlinked-bundled",
    });
    fs.rmSync(plugin.file);
    try {
      fs.linkSync(outsideEntry, plugin.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw error;
    }

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["hardlinked-bundled"],
          entries: {
            "hardlinked-bundled": { enabled: true },
          },
        },
      },
      workspaceDir: bundledDir,
    });

    const record = registry.plugins.find((entry) => entry.id === "hardlinked-bundled");
    expect(record?.status).toBe("loaded");
    expect(registry.diagnostics.some((entry) => entry.message.includes("unsafe plugin path"))).toBe(
      false,
    );
  });

  it("preserves runtime reflection semantics when runtime is lazily initialized", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    const plugin = writePlugin({
      body: `module.exports = { id: "runtime-introspection", register(api) {
  const runtime = api.runtime ?? {};
  const keys = Object.keys(runtime);
  if (!keys.includes("channel")) {
    throw new Error("runtime channel key missing");
  }
  if (!("channel" in runtime)) {
    throw new Error("runtime channel missing from has check");
  }
  if (!Object.getOwnPropertyDescriptor(runtime, "channel")) {
    throw new Error("runtime channel descriptor missing");
  }
} };`,
      filename: "runtime-introspection.cjs",
      id: "runtime-introspection",
    });

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadRegistryFromSinglePlugin({
        options: {
          onlyPluginIds: ["runtime-introspection"],
        },
        plugin,
        pluginConfig: {
          allow: ["runtime-introspection"],
        },
      }),
    );

    const record = registry.plugins.find((entry) => entry.id === "runtime-introspection");
    expect(record?.status).toBe("loaded");
  });

  it("supports legacy plugins importing monolithic plugin-sdk root", async () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      body: `module.exports = {
  id: "legacy-root-import",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
        register() {},
      };`,
      filename: "legacy-root-import.cjs",
      id: "legacy-root-import",
    });

    const registry = withEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins" }, () =>
      loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            allow: ["legacy-root-import"],
            load: { paths: [plugin.file] },
          },
        },
        workspaceDir: plugin.dir,
      }),
    );
    const record = registry.plugins.find((entry) => entry.id === "legacy-root-import");
    expect(record?.status).toBe("loaded");
  });

  it("supports legacy plugins subscribing to diagnostic events from the root sdk", async () => {
    useNoBundledPlugins();
    const seenKey = "__openclawLegacyRootDiagnosticSeen";
    delete (globalThis as Record<string, unknown>)[seenKey];

    const plugin = writePlugin({
      body: `module.exports = {
  id: "legacy-root-diagnostic-listener",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
  register() {
    const { onDiagnosticEvent } = require("openclaw/plugin-sdk");
    if (typeof onDiagnosticEvent !== "function") {
      throw new Error("missing onDiagnosticEvent root export");
    }
    globalThis.${seenKey} = [];
    onDiagnosticEvent((event) => {
      globalThis.${seenKey}.push({
        type: event.type,
        sessionKey: event.sessionKey,
      });
    });
  },
};`,
      filename: "legacy-root-diagnostic-listener.cjs",
      id: "legacy-root-diagnostic-listener",
    });

    try {
      const registry = withEnv(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins" },
        () =>
          loadOpenClawPlugins({
            cache: false,
            config: {
              plugins: {
                allow: ["legacy-root-diagnostic-listener"],
                load: { paths: [plugin.file] },
              },
            },
            workspaceDir: plugin.dir,
          }),
      );
      const record = registry.plugins.find(
        (entry) => entry.id === "legacy-root-diagnostic-listener",
      );
      expect(record?.status).toBe("loaded");

      emitDiagnosticEvent({
        sessionKey: "agent:main:test:dm:peer",
        type: "model.usage",
        usage: { total: 1 },
      });

      expect((globalThis as Record<string, unknown>)[seenKey]).toEqual([
        {
          sessionKey: "agent:main:test:dm:peer",
          type: "model.usage",
        },
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>)[seenKey];
    }
  });

  it("suppresses trust warning logs for non-activating snapshot loads", () => {
    useNoBundledPlugins();
    const stateDir = makeTempDir();
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const globalDir = path.join(stateDir, "extensions", "rogue");
      mkdirSafe(globalDir);
      writePlugin({
        body: simplePluginBody("rogue"),
        dir: globalDir,
        filename: "index.cjs",
        id: "rogue",
      });

      const warnings: string[] = [];
      const registry = loadOpenClawPlugins({
        activate: false,
        cache: false,
        config: {
          plugins: {
            enabled: true,
          },
        },
        logger: createWarningLogger(warnings),
      });

      expect(warnings).toEqual([]);
      expect(
        registry.diagnostics.some(
          (diag) =>
            diag.level === "warn" &&
            diag.pluginId === "rogue" &&
            diag.message.includes("loaded without install/load-path provenance"),
        ),
      ).toBe(true);
    });
  });

  it("loads source TypeScript plugins that route through local runtime shims", () => {
    const plugin = writePlugin({
      body: `import "./runtime-shim.ts";

export default {
  id: "source-runtime-shim",
  register() {},
};`,
      filename: "source-runtime-shim.ts",
      id: "source-runtime-shim",
    });
    fs.writeFileSync(
      path.join(plugin.dir, "runtime-shim.ts"),
      `import { helperValue } from "./helper.js";

export const runtimeValue = helperValue;`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(plugin.dir, "helper.ts"),
      `export const helperValue = "ok";`,
      "utf8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          allow: ["source-runtime-shim"],
          load: { paths: [plugin.file] },
        },
      },
      workspaceDir: plugin.dir,
    });

    const record = registry.plugins.find((entry) => entry.id === "source-runtime-shim");
    expect(record?.status).toBe("loaded");
  });

  it("converts Windows absolute import specifiers to file URLs only for module loading", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(__testing.toSafeImportPath(String.raw`C:\Users\alice\plugin\index.mjs`)).toBe(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
      expect(__testing.toSafeImportPath(String.raw`\\server\share\plugin\index.mjs`)).toBe(
        "file://server/share/plugin/index.mjs",
      );
      expect(__testing.toSafeImportPath("file:///C:/Users/alice/plugin/index.mjs")).toBe(
        "file:///C:/Users/alice/plugin/index.mjs",
      );
      expect(__testing.toSafeImportPath("./relative/index.mjs")).toBe("./relative/index.mjs");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
