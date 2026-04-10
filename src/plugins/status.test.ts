import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOOK_ONLY_MESSAGE,
  LEGACY_BEFORE_AGENT_START_MESSAGE,
  createCompatibilityNotice,
  createCustomHook,
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
} from "./status.test-helpers.js";

const loadConfigMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();
const loadPluginMetadataRegistrySnapshotMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const resolveBundledProviderCompatPluginIdsMock = vi.fn();
const withBundledPluginAllowlistCompatMock = vi.fn();
const withBundledPluginEnablementCompatMock = vi.fn();
const listImportedBundledPluginFacadeIdsMock = vi.fn();
const listImportedRuntimePluginIdsMock = vi.fn();
let buildPluginSnapshotReport: typeof import("./status.js").buildPluginSnapshotReport;
let buildPluginDiagnosticsReport: typeof import("./status.js").buildPluginDiagnosticsReport;
let buildPluginInspectReport: typeof import("./status.js").buildPluginInspectReport;
let buildAllPluginInspectReports: typeof import("./status.js").buildAllPluginInspectReports;
let buildPluginCompatibilityNotices: typeof import("./status.js").buildPluginCompatibilityNotices;
let buildPluginCompatibilityWarnings: typeof import("./status.js").buildPluginCompatibilityWarnings;
let formatPluginCompatibilityNotice: typeof import("./status.js").formatPluginCompatibilityNotice;
let summarizePluginCompatibility: typeof import("./status.js").summarizePluginCompatibility;

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("./runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    loadPluginMetadataRegistrySnapshotMock(...args),
}));

vi.mock("./providers.js", () => ({
  resolveBundledProviderCompatPluginIds: (...args: unknown[]) =>
    resolveBundledProviderCompatPluginIdsMock(...args),
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: (...args: unknown[]) =>
    withBundledPluginAllowlistCompatMock(...args),
  withBundledPluginEnablementCompat: (...args: unknown[]) =>
    withBundledPluginEnablementCompatMock(...args),
}));

vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  listImportedBundledPluginFacadeIds: (...args: unknown[]) =>
    listImportedBundledPluginFacadeIdsMock(...args),
}));

vi.mock("./runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  listImportedRuntimePluginIds: (...args: unknown[]) => listImportedRuntimePluginIdsMock(...args),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => undefined,
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/default-workspace",
}));

function setPluginLoadResult(overrides: Partial<ReturnType<typeof createPluginLoadResult>>) {
  const result = createPluginLoadResult({
    plugins: [],
    ...overrides,
  });
  loadOpenClawPluginsMock.mockReturnValue(result);
  loadPluginMetadataRegistrySnapshotMock.mockReturnValue(result);
}

function setSinglePluginLoadResult(
  plugin: ReturnType<typeof createPluginRecord>,
  overrides: Omit<Partial<ReturnType<typeof createPluginLoadResult>>, "plugins"> = {},
) {
  setPluginLoadResult({
    plugins: [plugin],
    ...overrides,
  });
}

function expectInspectReport(
  pluginId: string,
): NonNullable<ReturnType<typeof buildPluginInspectReport>> {
  const inspect = buildPluginInspectReport({ id: pluginId });
  expect(inspect).not.toBeNull();
  if (!inspect) {
    throw new Error(`expected inspect report for ${pluginId}`);
  }
  return inspect;
}

function expectPluginLoaderCall(params: {
  config?: unknown;
  activationSourceConfig?: unknown;
  autoEnabledReasons?: Record<string, string[]>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  loadModules?: boolean;
}) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      ...(params.autoEnabledReasons !== undefined
        ? { autoEnabledReasons: params.autoEnabledReasons }
        : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.loadModules !== undefined ? { loadModules: params.loadModules } : {}),
    }),
  );
}

function expectMetadataSnapshotLoaderCall(params: {
  config?: unknown;
  activationSourceConfig?: unknown;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  loadModules?: boolean;
}) {
  expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.activationSourceConfig !== undefined
        ? { activationSourceConfig: params.activationSourceConfig }
        : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.loadModules !== undefined ? { loadModules: params.loadModules } : {}),
    }),
  );
}

function expectAutoEnabledStatusLoad(params: { rawConfig: unknown }) {
  expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
}

function createCompatChainFixture() {
  const config = { plugins: { allow: ["telegram"] } };
  const pluginIds = ["anthropic", "openai"];
  const compatConfig = { plugins: { allow: ["telegram", ...pluginIds] } };
  const enabledConfig = {
    plugins: {
      allow: ["telegram", ...pluginIds],
      entries: {
        anthropic: { enabled: true },
        openai: { enabled: true },
      },
    },
  };
  return { compatConfig, config, enabledConfig, pluginIds };
}

function expectBundledCompatChainApplied(params: {
  config: unknown;
  pluginIds: string[];
  compatConfig: unknown;
  enabledConfig: unknown;
  loadModules: boolean;
}) {
  expect(withBundledPluginAllowlistCompatMock).toHaveBeenCalledWith({
    config: params.config,
    pluginIds: params.pluginIds,
  });
  expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledWith({
    config: params.compatConfig,
    pluginIds: params.pluginIds,
  });
  if (params.loadModules) {
    expectPluginLoaderCall({ config: params.enabledConfig, loadModules: true });
    return;
  }
  expectMetadataSnapshotLoaderCall({ config: params.enabledConfig, loadModules: false });
}

function createAutoEnabledStatusConfig(
  entries: Record<string, unknown>,
  rawConfigOverrides?: Record<string, unknown>,
) {
  const rawConfig = {
    plugins: {},
    ...rawConfigOverrides,
  };
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries,
    },
  };
  return { autoEnabledConfig, rawConfig };
}

function expectAutoEnabledDemoCompatibilityNoticesPreserveRawConfig() {
  const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
    {
      demo: { enabled: true },
    },
    { channels: { demo: { enabled: true } } },
  );
  const autoEnabledReasons = {
    demo: ["demo configured"],
  };
  applyPluginAutoEnableMock.mockReturnValue({
    autoEnabledReasons,
    changes: [],
    config: autoEnabledConfig,
  });
  setSinglePluginLoadResult(
    createPluginRecord({
      description: "Auto-enabled plugin",
      hookCount: 1,
      id: "demo",
      name: "Demo",
      origin: "bundled",
    }),
    {
      typedHooks: [createTypedHook({ hookName: "before_agent_start", pluginId: "demo" })],
    },
  );

  expect(buildPluginCompatibilityNotices({ config: rawConfig })).toEqual([
    createCompatibilityNotice({ code: "legacy-before-agent-start", pluginId: "demo" }),
    createCompatibilityNotice({ code: "hook-only", pluginId: "demo" }),
  ]);

  expectAutoEnabledStatusLoad({
    rawConfig,
  });
  expectPluginLoaderCall({
    activationSourceConfig: rawConfig,
    autoEnabledReasons,
    config: autoEnabledConfig,
    loadModules: true,
  });
}

function expectNoCompatibilityWarnings() {
  expect(buildPluginCompatibilityNotices()).toEqual([]);
  expect(buildPluginCompatibilityWarnings()).toEqual([]);
}

function expectCompatibilityOutput(params: { notices?: unknown[]; warnings?: string[] }) {
  if (params.notices) {
    expect(buildPluginCompatibilityNotices()).toEqual(params.notices);
  }
  if (params.warnings) {
    expect(buildPluginCompatibilityWarnings()).toEqual(params.warnings);
  }
}

function expectCapabilityKinds(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  kinds: readonly string[],
) {
  expect(inspect.capabilities.map((entry) => entry.kind)).toEqual(kinds);
}

function expectInspectShape(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  params: {
    shape: string;
    capabilityMode: string;
    capabilityKinds: readonly string[];
  },
) {
  expect(inspect.shape).toBe(params.shape);
  expect(inspect.capabilityMode).toBe(params.capabilityMode);
  expectCapabilityKinds(inspect, params.capabilityKinds);
}

function expectInspectPolicy(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  expected: Record<string, unknown>,
) {
  expect(inspect.policy).toEqual(expected);
}

function expectBundleInspectState(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  params: {
    bundleCapabilities: readonly string[];
    shape: string;
  },
) {
  expect(inspect.bundleCapabilities).toEqual(params.bundleCapabilities);
  expect(inspect.mcpServers).toEqual([]);
  expect(inspect.shape).toBe(params.shape);
}

describe("plugin status reports", () => {
  beforeAll(async () => {
    ({
      buildAllPluginInspectReports,
      buildPluginCompatibilityNotices,
      buildPluginDiagnosticsReport,
      buildPluginCompatibilityWarnings,
      buildPluginInspectReport,
      buildPluginSnapshotReport,
      formatPluginCompatibilityNotice,
      summarizePluginCompatibility,
    } = await import("./status.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    loadPluginMetadataRegistrySnapshotMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveBundledProviderCompatPluginIdsMock.mockReset();
    withBundledPluginAllowlistCompatMock.mockReset();
    withBundledPluginEnablementCompatMock.mockReset();
    listImportedBundledPluginFacadeIdsMock.mockReset();
    listImportedRuntimePluginIdsMock.mockReset();
    loadConfigMock.mockReturnValue({});
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      autoEnabledReasons: {},
      changes: [],
      config: params.config,
    }));
    resolveBundledProviderCompatPluginIdsMock.mockReturnValue([]);
    withBundledPluginAllowlistCompatMock.mockImplementation(
      (params: { config: unknown }) => params.config,
    );
    withBundledPluginEnablementCompatMock.mockImplementation(
      (params: { config: unknown }) => params.config,
    );
    listImportedBundledPluginFacadeIdsMock.mockReturnValue([]);
    listImportedRuntimePluginIdsMock.mockReturnValue([]);
    setPluginLoadResult({ plugins: [] });
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    buildPluginSnapshotReport({
      config: {},
      env,
      workspaceDir: "/workspace",
    });

    expectMetadataSnapshotLoaderCall({
      config: {},
      env,
      loadModules: false,
      workspaceDir: "/workspace",
    });
  });

  it("uses a metadata snapshot load for snapshot reports", () => {
    buildPluginSnapshotReport({ config: {}, workspaceDir: "/workspace" });

    expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        loadModules: false,
      }),
    );
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin status from the auto-enabled config snapshot", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
      {
        demo: { enabled: true },
      },
      { channels: { demo: { enabled: true } } },
    );
    applyPluginAutoEnableMock.mockReturnValue({
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });

    buildPluginSnapshotReport({ config: rawConfig });

    expectAutoEnabledStatusLoad({
      rawConfig,
    });
    expectMetadataSnapshotLoaderCall({
      activationSourceConfig: rawConfig,
      config: autoEnabledConfig,
      loadModules: false,
    });
  });

  it("uses the auto-enabled config snapshot for inspect policy summaries", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
      {
        demo: {
          enabled: true,
          subagent: {
            allowModelOverride: true,
            allowedModels: ["openai/gpt-5.4"],
            hasAllowedModelsConfig: true,
          },
        },
      },
      { channels: { demo: { enabled: true } } },
    );
    applyPluginAutoEnableMock.mockReturnValue({
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });
    setSinglePluginLoadResult(
      createPluginRecord({
        description: "Auto-enabled plugin",
        id: "demo",
        name: "Demo",
        origin: "bundled",
        providerIds: ["demo"],
      }),
    );

    const inspect = buildPluginInspectReport({ config: rawConfig, id: "demo" });

    expect(inspect).not.toBeNull();
    expectInspectPolicy(inspect!, {
      allowModelOverride: true,
      allowPromptInjection: undefined,
      allowedModels: ["openai/gpt-5.4"],
      hasAllowedModelsConfig: true,
    });
    expectPluginLoaderCall({ loadModules: true });
  });

  it("preserves raw config activation context when compatibility notices build their own report", () => {
    expectAutoEnabledDemoCompatibilityNoticesPreserveRawConfig();
  });

  it("applies the full bundled provider compat chain before loading plugins", () => {
    const { config, pluginIds, compatConfig, enabledConfig } = createCompatChainFixture();
    loadConfigMock.mockReturnValue(config);
    resolveBundledProviderCompatPluginIdsMock.mockReturnValue(pluginIds);
    withBundledPluginAllowlistCompatMock.mockReturnValue(compatConfig);
    withBundledPluginEnablementCompatMock.mockReturnValue(enabledConfig);

    buildPluginSnapshotReport({ config });

    expectBundledCompatChainApplied({
      compatConfig,
      config,
      enabledConfig,
      loadModules: false,
      pluginIds,
    });
  });

  it("preserves raw config activation context for compatibility-derived reports", () => {
    expectAutoEnabledDemoCompatibilityNoticesPreserveRawConfig();
  });

  it("normalizes bundled plugin versions to the core base release", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        channelIds: ["whatsapp"],
        description: "Bundled channel plugin",
        id: "whatsapp",
        name: "WhatsApp",
        origin: "bundled",
        version: "2026.3.22",
      }),
    );

    const report = buildPluginDiagnosticsReport({
      config: {},
      env: {
        OPENCLAW_VERSION: "2026.3.23-1",
      } as NodeJS.ProcessEnv,
    });

    expect(report.plugins[0]?.version).toBe("2026.3.23");
  });

  it("marks plugins as imported when runtime or facade state has loaded them", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({ id: "runtime-loaded" }),
        createPluginRecord({ id: "facade-loaded" }),
        createPluginRecord({ format: "bundle", id: "bundle-loaded" }),
        createPluginRecord({ id: "cold-plugin" }),
      ],
    });
    listImportedRuntimePluginIdsMock.mockReturnValue(["runtime-loaded", "bundle-loaded"]);
    listImportedBundledPluginFacadeIdsMock.mockReturnValue(["facade-loaded"]);

    const report = buildPluginSnapshotReport({ config: {} });

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime-loaded", imported: true }),
        expect.objectContaining({ id: "facade-loaded", imported: true }),
        expect.objectContaining({ id: "bundle-loaded", imported: false }),
        expect.objectContaining({ id: "cold-plugin", imported: false }),
      ]),
    );
  });

  it("marks snapshot-loaded plugin modules as imported during full report loads", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({ id: "runtime-loaded" }),
        createPluginRecord({ format: "bundle", id: "bundle-loaded" }),
      ],
    });

    const report = buildPluginDiagnosticsReport({ config: {} });

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime-loaded", imported: true }),
        expect.objectContaining({ id: "bundle-loaded", imported: false }),
      ]),
    );
  });

  it("marks errored plugin modules as imported when full diagnostics already evaluated them", () => {
    setPluginLoadResult({
      plugins: [createPluginRecord({ id: "broken-plugin", status: "error" })],
    });
    listImportedRuntimePluginIdsMock.mockReturnValue(["broken-plugin"]);

    const report = buildPluginDiagnosticsReport({ config: {} });

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "broken-plugin", imported: true, status: "error" }),
      ]),
    );
  });

  it("builds an inspect report with capability shape and policy", () => {
    loadConfigMock.mockReturnValue({
      plugins: {
        entries: {
          google: {
            hooks: { allowPromptInjection: false },
            subagent: {
              allowModelOverride: true,
              allowedModels: ["openai/gpt-5.4"],
            },
          },
        },
      },
    });
    setPluginLoadResult({
      diagnostics: [{ level: "warn", message: "watch this surface", pluginId: "google" }],
      plugins: [
        createPluginRecord({
          description: "Google provider plugin",
          id: "google",
          imageGenerationProviderIds: ["google"],
          mediaUnderstandingProviderIds: ["google"],
          name: "Google",
          origin: "bundled",
          providerIds: ["google"],
          webSearchProviderIds: ["google"],
        }),
      ],
      typedHooks: [createTypedHook({ hookName: "before_agent_start", pluginId: "google" })],
    });

    const inspect = buildPluginInspectReport({ id: "google" });

    expect(inspect).not.toBeNull();
    expectInspectShape(inspect!, {
      capabilityKinds: ["text-inference", "media-understanding", "image-generation", "web-search"],
      capabilityMode: "hybrid",
      shape: "hybrid-capability",
    });
    expect(inspect?.usesLegacyBeforeAgentStart).toBe(true);
    expect(inspect?.compatibility).toEqual([
      createCompatibilityNotice({ code: "legacy-before-agent-start", pluginId: "google" }),
    ]);
    expectInspectPolicy(inspect!, {
      allowModelOverride: true,
      allowPromptInjection: false,
      allowedModels: ["openai/gpt-5.4"],
      hasAllowedModelsConfig: true,
    });
    expect(inspect?.diagnostics).toEqual([
      { level: "warn", message: "watch this surface", pluginId: "google" },
    ]);
  });

  it("builds inspect reports for every loaded plugin", () => {
    setPluginLoadResult({
      hooks: [createCustomHook({ events: ["message"], pluginId: "lca" })],
      plugins: [
        createPluginRecord({
          description: "Legacy hook plugin",
          hookCount: 1,
          id: "lca",
          name: "LCA",
        }),
        createPluginRecord({
          description: "Hybrid capability plugin",
          id: "microsoft",
          name: "Microsoft",
          origin: "bundled",
          providerIds: ["microsoft"],
          webSearchProviderIds: ["microsoft"],
        }),
      ],
      typedHooks: [createTypedHook({ hookName: "before_agent_start", pluginId: "lca" })],
    });

    const inspect = buildAllPluginInspectReports();

    expect(inspect.map((entry) => entry.plugin.id)).toEqual(["lca", "microsoft"]);
    expect(inspect.map((entry) => entry.shape)).toEqual(["hook-only", "hybrid-capability"]);
    expect(inspect[0]?.usesLegacyBeforeAgentStart).toBe(true);
    expectCapabilityKinds(inspect[1], ["text-inference", "web-search"]);
  });

  it("treats a CLI-command-only plugin as a plain capability", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        cliBackendIds: ["claude-cli"],
        id: "anthropic",
        name: "Anthropic",
      }),
    );

    const inspect = expectInspectReport("anthropic");

    expectInspectShape(inspect, {
      capabilityKinds: ["cli-backend"],
      capabilityMode: "plain",
      shape: "plain-capability",
    });
    expect(inspect.capabilities).toEqual([{ ids: ["claude-cli"], kind: "cli-backend" }]);
  });

  it("builds compatibility warnings for legacy compatibility paths", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          description: "Legacy hook plugin",
          hookCount: 1,
          id: "lca",
          name: "LCA",
        }),
      ],
      typedHooks: [createTypedHook({ hookName: "before_agent_start", pluginId: "lca" })],
    });

    expectCompatibilityOutput({
      warnings: [`lca ${LEGACY_BEFORE_AGENT_START_MESSAGE}`, `lca ${HOOK_ONLY_MESSAGE}`],
    });
  });

  it("builds structured compatibility notices with deterministic ordering", () => {
    setPluginLoadResult({
      hooks: [createCustomHook({ events: ["message"], pluginId: "hook-only" })],
      plugins: [
        createPluginRecord({
          hookCount: 1,
          id: "hook-only",
          name: "Hook Only",
        }),
        createPluginRecord({
          hookCount: 1,
          id: "legacy-only",
          name: "Legacy Only",
          providerIds: ["legacy-only"],
        }),
      ],
      typedHooks: [createTypedHook({ hookName: "before_agent_start", pluginId: "legacy-only" })],
    });

    expectCompatibilityOutput({
      notices: [
        createCompatibilityNotice({ code: "hook-only", pluginId: "hook-only" }),
        createCompatibilityNotice({ code: "legacy-before-agent-start", pluginId: "legacy-only" }),
      ],
    });
  });

  it("returns no compatibility warnings for modern capability plugins", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "modern",
        name: "Modern",
        providerIds: ["modern"],
      }),
    );

    expectNoCompatibilityWarnings();
  });

  it.each([
    {
      expectedBundleCapabilities: ["skills", "commands", "agents", "settings"],
      expectedId: "claude-bundle",
      expectedShape: "non-capability",
      name: "populates bundleCapabilities from plugin record",
      plugin: createPluginRecord({
        bundleCapabilities: ["skills", "commands", "agents", "settings"],
        bundleFormat: "claude",
        description: "A bundle plugin with skills and commands",
        format: "bundle",
        id: "claude-bundle",
        name: "Claude Bundle",
        rootDir: "/tmp/claude-bundle",
        source: "/tmp/claude-bundle/.claude-plugin/plugin.json",
      }),
    },
    {
      expectedBundleCapabilities: [],
      expectedId: "plain-plugin",
      expectedShape: "plain-capability",
      name: "returns empty bundleCapabilities and mcpServers for non-bundle plugins",
      plugin: createPluginRecord({
        description: "A regular plugin",
        id: "plain-plugin",
        name: "Plain Plugin",
        providerIds: ["plain"],
      }),
    },
  ])("$name", ({ plugin, expectedId, expectedBundleCapabilities, expectedShape }) => {
    setSinglePluginLoadResult(plugin);

    const inspect = expectInspectReport(expectedId);

    expectBundleInspectState(inspect, {
      bundleCapabilities: expectedBundleCapabilities,
      shape: expectedShape,
    });
  });

  it("formats and summarizes compatibility notices", () => {
    const notice = createCompatibilityNotice({
      code: "legacy-before-agent-start",
      pluginId: "legacy-plugin",
    });

    expect(formatPluginCompatibilityNotice(notice)).toBe(
      `legacy-plugin ${LEGACY_BEFORE_AGENT_START_MESSAGE}`,
    );
    expect(
      summarizePluginCompatibility([
        notice,
        createCompatibilityNotice({ code: "hook-only", pluginId: "legacy-plugin" }),
      ]),
    ).toEqual({
      noticeCount: 2,
      pluginCount: 1,
    });
  });
});
