import { Command } from "commander";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type LoadConfigFn = (typeof import("../config/config.js"))["loadConfig"];
type ParseClawHubPluginSpecFn = (typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"];
type InstallPluginFromMarketplaceFn =
  (typeof import("../plugins/marketplace.js"))["installPluginFromMarketplace"];
type ListMarketplacePluginsFn =
  (typeof import("../plugins/marketplace.js"))["listMarketplacePlugins"];
type ResolveMarketplaceInstallShortcutFn =
  (typeof import("../plugins/marketplace.js"))["resolveMarketplaceInstallShortcut"];

function invokeMock<TArgs extends unknown[], TResult>(mock: unknown, ...args: TArgs): TResult {
  return (mock as (...args: TArgs) => TResult)(...args);
}

export const loadConfig: Mock<LoadConfigFn> = vi.fn<LoadConfigFn>(() => ({}) as OpenClawConfig);
export const readConfigFileSnapshot: AsyncUnknownMock = vi.fn();
export const writeConfigFile: AsyncUnknownMock = vi.fn(async () => undefined);
export const replaceConfigFile: AsyncUnknownMock = vi.fn(
  async (params: { nextConfig: OpenClawConfig }) => await writeConfigFile(params.nextConfig),
) as AsyncUnknownMock;
export const resolveStateDir: Mock<() => string> = vi.fn(() => "/tmp/openclaw-state");
export const installPluginFromMarketplace: Mock<InstallPluginFromMarketplaceFn> = vi.fn();
export const listMarketplacePlugins: Mock<ListMarketplacePluginsFn> = vi.fn();
export const resolveMarketplaceInstallShortcut: Mock<ResolveMarketplaceInstallShortcutFn> = vi.fn();
export const enablePluginInConfig: UnknownMock = vi.fn();
export const recordPluginInstall: UnknownMock = vi.fn();
export const clearPluginManifestRegistryCache: UnknownMock = vi.fn();
export const loadPluginManifestRegistry: UnknownMock = vi.fn();
export const buildPluginSnapshotReport: UnknownMock = vi.fn();
export const buildPluginDiagnosticsReport: UnknownMock = vi.fn();
export const buildPluginCompatibilityNotices: UnknownMock = vi.fn();
export const applyExclusiveSlotSelection: UnknownMock = vi.fn();
export const uninstallPlugin: AsyncUnknownMock = vi.fn();
export const updateNpmInstalledPlugins: AsyncUnknownMock = vi.fn();
export const updateNpmInstalledHookPacks: AsyncUnknownMock = vi.fn();
export const promptYesNo: AsyncUnknownMock = vi.fn();
export const installPluginFromNpmSpec: AsyncUnknownMock = vi.fn();
export const installPluginFromPath: AsyncUnknownMock = vi.fn();
export const installPluginFromClawHub: AsyncUnknownMock = vi.fn();
export const parseClawHubPluginSpec: Mock<ParseClawHubPluginSpecFn> = vi.fn();
export const installHooksFromNpmSpec: AsyncUnknownMock = vi.fn();
export const installHooksFromPath: AsyncUnknownMock = vi.fn();
export const recordHookInstall: UnknownMock = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

export { runtimeErrors, runtimeLogs };

function restoreRuntimeCaptureMocks() {
  defaultRuntime.log.mockReset();
  defaultRuntime.log.mockImplementation((...args: unknown[]) => {
    runtimeLogs.push(args.map((value) => String(value)).join(" "));
  });

  defaultRuntime.error.mockReset();
  defaultRuntime.error.mockImplementation((...args: unknown[]) => {
    runtimeErrors.push(args.map((value) => String(value)).join(" "));
  });

  defaultRuntime.writeStdout.mockReset();
  defaultRuntime.writeStdout.mockImplementation((value: string) => {
    defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
  });

  defaultRuntime.writeJson.mockReset();
  defaultRuntime.writeJson.mockImplementation((value: unknown, space = 2) => {
    defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
  });

  defaultRuntime.exit.mockReset();
  defaultRuntime.exit.mockImplementation((code: number) => {
    throw new Error(`__exit__:${code}`);
  });
}

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: ((
    ...args: Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>,
      ReturnType<(typeof import("../config/config.js"))["readConfigFileSnapshot"]>
    >(
      readConfigFileSnapshot,
      ...args,
    )) as (typeof import("../config/config.js"))["readConfigFileSnapshot"],
  replaceConfigFile: ((
    params: Parameters<(typeof import("../config/config.js"))["replaceConfigFile"]>[0],
  ) =>
    invokeMock<
      [Parameters<(typeof import("../config/config.js"))["replaceConfigFile"]>[0]],
      ReturnType<(typeof import("../config/config.js"))["replaceConfigFile"]>
    >(replaceConfigFile, params)) as (typeof import("../config/config.js"))["replaceConfigFile"],
  writeConfigFile: ((config: OpenClawConfig) =>
    invokeMock<
      [OpenClawConfig],
      ReturnType<(typeof import("../config/config.js"))["writeConfigFile"]>
    >(writeConfigFile, config)) as (typeof import("../config/config.js"))["writeConfigFile"],
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => resolveStateDir(),
}));

vi.mock("../plugins/marketplace.js", () => ({
  installPluginFromMarketplace: ((...args: Parameters<InstallPluginFromMarketplaceFn>) =>
    installPluginFromMarketplace(...args)) as InstallPluginFromMarketplaceFn,
  listMarketplacePlugins: ((...args: Parameters<ListMarketplacePluginsFn>) =>
    listMarketplacePlugins(...args)) as ListMarketplacePluginsFn,
  resolveMarketplaceInstallShortcut: ((...args: Parameters<ResolveMarketplaceInstallShortcutFn>) =>
    resolveMarketplaceInstallShortcut(...args)) as ResolveMarketplaceInstallShortcutFn,
}));

vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: ((cfg: OpenClawConfig, pluginId: string) =>
    invokeMock<[OpenClawConfig, string], unknown>(
      enablePluginInConfig,
      cfg,
      pluginId,
    )) as (typeof import("../plugins/enable.js"))["enablePluginInConfig"],
}));

vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall: ((
    ...args: Parameters<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>,
      ReturnType<(typeof import("../plugins/installs.js"))["recordPluginInstall"]>
    >(
      recordPluginInstall,
      ...args,
    )) as (typeof import("../plugins/installs.js"))["recordPluginInstall"],
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => clearPluginManifestRegistryCache(),
  loadPluginManifestRegistry: ((...args: unknown[]) =>
    invokeMock<unknown[], unknown>(loadPluginManifestRegistry, ...args)) as (
    ...args: unknown[]
  ) => unknown,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"]>
    >(
      buildPluginCompatibilityNotices,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginCompatibilityNotices"],
  buildPluginDiagnosticsReport: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"]>
    >(
      buildPluginDiagnosticsReport,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginDiagnosticsReport"],
  buildPluginSnapshotReport: ((
    ...args: Parameters<(typeof import("../plugins/status.js"))["buildPluginSnapshotReport"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/status.js"))["buildPluginSnapshotReport"]>,
      ReturnType<(typeof import("../plugins/status.js"))["buildPluginSnapshotReport"]>
    >(
      buildPluginSnapshotReport,
      ...args,
    )) as (typeof import("../plugins/status.js"))["buildPluginSnapshotReport"],
}));

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: ((
    params: Parameters<(typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"]>[0],
  ) =>
    invokeMock<
      [Parameters<(typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"]>[0]],
      ReturnType<(typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"]>
    >(
      applyExclusiveSlotSelection,
      params,
    )) as (typeof import("../plugins/slots.js"))["applyExclusiveSlotSelection"],
}));

vi.mock("../plugins/uninstall.js", () => ({
  resolveUninstallDirectoryTarget: ({
    installRecord,
  }: {
    installRecord?: { installPath?: string; sourcePath?: string };
  }) => installRecord?.installPath ?? installRecord?.sourcePath ?? null,
  uninstallPlugin: ((
    ...args: Parameters<(typeof import("../plugins/uninstall.js"))["uninstallPlugin"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/uninstall.js"))["uninstallPlugin"]>,
      ReturnType<(typeof import("../plugins/uninstall.js"))["uninstallPlugin"]>
    >(uninstallPlugin, ...args)) as (typeof import("../plugins/uninstall.js"))["uninstallPlugin"],
}));

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins: ((
    ...args: Parameters<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>,
      ReturnType<(typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"]>
    >(
      updateNpmInstalledPlugins,
      ...args,
    )) as (typeof import("../plugins/update.js"))["updateNpmInstalledPlugins"],
}));

vi.mock("../hooks/update.js", () => ({
  updateNpmInstalledHookPacks: ((
    ...args: Parameters<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>,
      ReturnType<(typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"]>
    >(
      updateNpmInstalledHookPacks,
      ...args,
    )) as (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"],
}));

vi.mock("./prompt.js", () => ({
  promptYesNo: ((...args: Parameters<(typeof import("./prompt.js"))["promptYesNo"]>) =>
    invokeMock<
      Parameters<(typeof import("./prompt.js"))["promptYesNo"]>,
      ReturnType<(typeof import("./prompt.js"))["promptYesNo"]>
    >(promptYesNo, ...args)) as (typeof import("./prompt.js"))["promptYesNo"],
}));

vi.mock("../plugins/install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
  installPluginFromNpmSpec: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromNpmSpec"]>
    >(
      installPluginFromNpmSpec,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromNpmSpec"],
  installPluginFromPath: ((
    ...args: Parameters<(typeof import("../plugins/install.js"))["installPluginFromPath"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/install.js"))["installPluginFromPath"]>,
      ReturnType<(typeof import("../plugins/install.js"))["installPluginFromPath"]>
    >(
      installPluginFromPath,
      ...args,
    )) as (typeof import("../plugins/install.js"))["installPluginFromPath"],
}));

vi.mock("../hooks/install.js", () => ({
  installHooksFromNpmSpec: ((
    ...args: Parameters<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>,
      ReturnType<(typeof import("../hooks/install.js"))["installHooksFromNpmSpec"]>
    >(
      installHooksFromNpmSpec,
      ...args,
    )) as (typeof import("../hooks/install.js"))["installHooksFromNpmSpec"],
  installHooksFromPath: ((
    ...args: Parameters<(typeof import("../hooks/install.js"))["installHooksFromPath"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/install.js"))["installHooksFromPath"]>,
      ReturnType<(typeof import("../hooks/install.js"))["installHooksFromPath"]>
    >(
      installHooksFromPath,
      ...args,
    )) as (typeof import("../hooks/install.js"))["installHooksFromPath"],
  resolveHookInstallDir: (hookId: string) => `/tmp/hooks/${hookId}`,
}));

vi.mock("../hooks/installs.js", () => ({
  recordHookInstall: ((
    ...args: Parameters<(typeof import("../hooks/installs.js"))["recordHookInstall"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../hooks/installs.js"))["recordHookInstall"]>,
      ReturnType<(typeof import("../hooks/installs.js"))["recordHookInstall"]>
    >(recordHookInstall, ...args)) as (typeof import("../hooks/installs.js"))["recordHookInstall"],
}));

vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
  },
  formatClawHubSpecifier: ({ name, version }: { name: string; version?: string }) =>
    `clawhub:${name}${version ? `@${version}` : ""}`,
  installPluginFromClawHub: ((
    ...args: Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>,
      ReturnType<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
    >(
      installPluginFromClawHub,
      ...args,
    )) as (typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"],
}));

vi.mock("../infra/clawhub.js", () => ({
  parseClawHubPluginSpec: ((
    ...args: Parameters<(typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"]>
  ) =>
    invokeMock<
      Parameters<(typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"]>,
      ReturnType<(typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"]>
    >(
      parseClawHubPluginSpec,
      ...args,
    )) as (typeof import("../infra/clawhub.js"))["parseClawHubPluginSpec"],
}));

const { registerPluginsCli } = await import("./plugins-cli.js");

export { registerPluginsCli };

export async function runPluginsCommand(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  vi.resetModules();
  const { registerPluginsCli: registerPluginsCliFresh } = await import("./plugins-cli.js");
  registerPluginsCliFresh(program);
  return await program.parseAsync(argv, { from: "user" });
}

export function resetPluginsCliTestState() {
  resetRuntimeCapture();
  restoreRuntimeCaptureMocks();
  loadConfig.mockReset();
  readConfigFileSnapshot.mockReset();
  writeConfigFile.mockReset();
  replaceConfigFile.mockReset();
  resolveStateDir.mockReset();
  installPluginFromMarketplace.mockReset();
  listMarketplacePlugins.mockReset();
  resolveMarketplaceInstallShortcut.mockReset();
  enablePluginInConfig.mockReset();
  recordPluginInstall.mockReset();
  clearPluginManifestRegistryCache.mockReset();
  loadPluginManifestRegistry.mockReset();
  buildPluginSnapshotReport.mockReset();
  buildPluginDiagnosticsReport.mockReset();
  buildPluginCompatibilityNotices.mockReset();
  applyExclusiveSlotSelection.mockReset();
  uninstallPlugin.mockReset();
  updateNpmInstalledPlugins.mockReset();
  updateNpmInstalledHookPacks.mockReset();
  promptYesNo.mockReset();
  installPluginFromNpmSpec.mockReset();
  installPluginFromPath.mockReset();
  installPluginFromClawHub.mockReset();
  parseClawHubPluginSpec.mockReset();
  installHooksFromNpmSpec.mockReset();
  installHooksFromPath.mockReset();
  recordHookInstall.mockReset();

  loadConfig.mockReturnValue({} as OpenClawConfig);
  readConfigFileSnapshot.mockImplementation(async () => {
    const config = loadConfig();
    return {
      config,
      exists: true,
      hash: "mock",
      issues: [],
      legacyIssues: [],
      parsed: config,
      path: "/tmp/openclaw-config.json5",
      raw: "{}",
      resolved: config,
      runtimeConfig: config,
      sourceConfig: config,
      valid: true,
      warnings: [],
    };
  });
  writeConfigFile.mockResolvedValue(undefined);
  replaceConfigFile.mockImplementation(
    (async (params: { nextConfig: OpenClawConfig }) =>
      await writeConfigFile(params.nextConfig)) as (...args: unknown[]) => Promise<unknown>,
  );
  resolveStateDir.mockReturnValue("/tmp/openclaw-state");
  resolveMarketplaceInstallShortcut.mockResolvedValue(null);
  installPluginFromMarketplace.mockResolvedValue({
    error: "marketplace install failed",
    ok: false,
  });
  enablePluginInConfig.mockImplementation(((cfg: OpenClawConfig) => ({ config: cfg })) as (
    ...args: unknown[]
  ) => unknown);
  recordPluginInstall.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
  loadPluginManifestRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [],
  });
  const defaultPluginReport = {
    diagnostics: [],
    plugins: [],
  };
  buildPluginSnapshotReport.mockReturnValue(defaultPluginReport);
  buildPluginDiagnosticsReport.mockReturnValue(defaultPluginReport);
  buildPluginCompatibilityNotices.mockReturnValue([]);
  applyExclusiveSlotSelection.mockImplementation((({ config }: { config: OpenClawConfig }) => ({
    config,
    warnings: [],
  })) as (...args: unknown[]) => unknown);
  uninstallPlugin.mockResolvedValue({
    actions: {
      allowlist: false,
      directory: false,
      entry: false,
      install: false,
      loadPath: false,
      memorySlot: false,
    },
    config: {} as OpenClawConfig,
    ok: true,
    warnings: [],
  });
  updateNpmInstalledPlugins.mockResolvedValue({
    changed: false,
    config: {} as OpenClawConfig,
    outcomes: [],
  });
  updateNpmInstalledHookPacks.mockResolvedValue({
    changed: false,
    config: {} as OpenClawConfig,
    outcomes: [],
  });
  promptYesNo.mockResolvedValue(true);
  installPluginFromPath.mockResolvedValue({ error: "path install disabled in test", ok: false });
  installPluginFromNpmSpec.mockResolvedValue({
    error: "npm install disabled in test",
    ok: false,
  });
  installPluginFromClawHub.mockResolvedValue({
    error: "clawhub install disabled in test",
    ok: false,
  });
  parseClawHubPluginSpec.mockReturnValue(null);
  installHooksFromPath.mockResolvedValue({
    error: "hook path install disabled in test",
    ok: false,
  });
  installHooksFromNpmSpec.mockResolvedValue({
    error: "hook npm install disabled in test",
    ok: false,
  });
  recordHookInstall.mockImplementation(
    ((cfg: OpenClawConfig) => cfg) as (...args: unknown[]) => unknown,
  );
}
