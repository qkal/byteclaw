import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import type { PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
import type { PluginDiagnostic, PluginHookName } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export type PluginCapabilityKind =
  | "cli-backend"
  | "text-inference"
  | "speech"
  | "realtime-transcription"
  | "realtime-voice"
  | "media-understanding"
  | "image-generation"
  | "web-search"
  | "channel";

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export interface PluginCompatibilityNotice {
  pluginId: string;
  code: "legacy-before-agent-start" | "hook-only";
  severity: "warn" | "info";
  message: string;
}

export interface PluginCompatibilitySummary {
  noticeCount: number;
  pluginCount: number;
}

export interface PluginInspectReport {
  workspaceDir?: string;
  plugin: PluginRegistry["plugins"][number];
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: {
    kind: PluginCapabilityKind;
    ids: string[];
  }[];
  typedHooks: {
    name: PluginHookName;
    priority?: number;
  }[];
  customHooks: {
    name: string;
    events: string[];
  }[];
  tools: {
    names: string[];
    optional: boolean;
  }[];
  commands: string[];
  cliCommands: string[];
  services: string[];
  gatewayMethods: string[];
  mcpServers: {
    name: string;
    hasStdioTransport: boolean;
  }[];
  lspServers: {
    name: string;
    hasStdioTransport: boolean;
  }[];
  httpRouteCount: number;
  bundleCapabilities: string[];
  diagnostics: PluginDiagnostic[];
  policy: {
    allowPromptInjection?: boolean;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
  compatibility: PluginCompatibilityNotice[];
}

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape" | "usesLegacyBeforeAgentStart">,
): PluginCompatibilityNotice[] {
  const warnings: PluginCompatibilityNotice[] = [];
  if (inspect.usesLegacyBeforeAgentStart) {
    warnings.push({
      code: "legacy-before-agent-start",
      message:
        "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      pluginId: inspect.plugin.id,
      severity: "warn",
    });
  }
  if (inspect.shape === "hook-only") {
    warnings.push({
      code: "hook-only",
      message:
        "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
      pluginId: inspect.plugin.id,
      severity: "info",
    });
  }
  return warnings;
}

function resolveReportedPluginVersion(
  plugin: PluginRegistry["plugins"][number],
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (plugin.origin !== "bundled") {
    return plugin.version;
  }
  return (
    normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ??
    normalizeOpenClawVersionBase(plugin.version) ??
    plugin.version
  );
}

interface PluginReportParams {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
}

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const baseContext = resolvePluginRuntimeLoadContext({
    config: params?.config ?? loadConfig(),
    env: params?.env,
    workspaceDir: params?.workspaceDir,
  });
  const workspaceDir = baseContext.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const context =
    workspaceDir === baseContext.workspaceDir
      ? baseContext
      : {
          ...baseContext,
          workspaceDir,
        };
  const { rawConfig } = context;
  const { config } = context;

  // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
  // Report the same loaded/disabled status the gateway uses at runtime.  Without
  // This, bundled provider plugins are incorrectly shown as "disabled" when
  // `plugins.allow` is set because the allowlist check runs before the
  // Bundled-default-enable check.  Scoped to bundled providers only (not all
  // Bundled plugins) to match the runtime compat surface in providers.runtime.ts.
  const bundledProviderIds = resolveBundledProviderCompatPluginIds({
    config,
    env: params?.env,
    workspaceDir,
  });
  const effectiveConfig = withBundledPluginAllowlistCompat({
    config,
    pluginIds: bundledProviderIds,
  });
  const runtimeCompatConfig = withBundledPluginEnablementCompat({
    config: effectiveConfig,
    pluginIds: bundledProviderIds,
  });

  const registry = loadModules
    ? loadOpenClawPlugins(
        buildPluginRuntimeLoadOptions(context, {
          activate: false,
          activationSourceConfig: rawConfig,
          cache: false,
          config: runtimeCompatConfig,
          env: params?.env,
          loadModules,
          workspaceDir,
        }),
      )
    : loadPluginMetadataRegistrySnapshot({
        activationSourceConfig: rawConfig,
        config: runtimeCompatConfig,
        env: params?.env,
        loadModules: false,
        workspaceDir,
      });
  const importedPluginIds = new Set([
    ...(loadModules
      ? registry.plugins
          .filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle")
          .map((plugin) => plugin.id)
      : []),
    ...listImportedRuntimePluginIds(),
    ...listImportedBundledPluginFacadeIds(),
  ]);

  return {
    workspaceDir,
    ...registry,
    plugins: registry.plugins.map((plugin) => ({
      ...plugin,
      imported: plugin.format !== "bundle" && importedPluginIds.has(plugin.id),
      version: resolveReportedPluginVersion(plugin, params?.env),
    })),
  };
}

export function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, false);
}

export function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, true);
}

function buildCapabilityEntries(plugin: PluginRegistry["plugins"][number]) {
  return [
    { ids: plugin.cliBackendIds ?? [], kind: "cli-backend" as const },
    { ids: plugin.providerIds, kind: "text-inference" as const },
    { ids: plugin.speechProviderIds, kind: "speech" as const },
    { ids: plugin.realtimeTranscriptionProviderIds, kind: "realtime-transcription" as const },
    { ids: plugin.realtimeVoiceProviderIds, kind: "realtime-voice" as const },
    { ids: plugin.mediaUnderstandingProviderIds, kind: "media-understanding" as const },
    { ids: plugin.imageGenerationProviderIds, kind: "image-generation" as const },
    { ids: plugin.webSearchProviderIds, kind: "web-search" as const },
    { ids: plugin.channelIds, kind: "channel" as const },
  ].filter((entry) => entry.ids.length > 0);
}

function deriveInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
  gatewayMethodCount: number;
  httpRouteCount: number;
}): PluginInspectShape {
  if (params.capabilityCount > 1) {
    return "hybrid-capability";
  }
  if (params.capabilityCount === 1) {
    return "plain-capability";
  }
  const hasOnlyHooks =
    params.typedHookCount + params.customHookCount > 0 &&
    params.toolCount === 0 &&
    params.commandCount === 0 &&
    params.cliCount === 0 &&
    params.serviceCount === 0 &&
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

export function buildPluginInspectReport(params: {
  id: string;
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport | null {
  const rawConfig = params.config ?? loadConfig();
  const { config } = resolvePluginRuntimeLoadContext({
    config: rawConfig,
    env: params.env,
    workspaceDir: params.workspaceDir,
  });
  const report =
    params.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      env: params.env,
      workspaceDir: params.workspaceDir,
    });
  const plugin = report.plugins.find((entry) => entry.id === params.id || entry.name === params.id);
  if (!plugin) {
    return null;
  }

  const capabilities = buildCapabilityEntries(plugin);
  const typedHooks = report.typedHooks
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      name: entry.hookName,
      priority: entry.priority,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const customHooks = report.hooks
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      events: [...entry.events].toSorted(),
      name: entry.entry.hook.name,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const tools = report.tools
    .filter((entry) => entry.pluginId === plugin.id)
    .map((entry) => ({
      names: [...entry.names],
      optional: entry.optional,
    }));
  const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === plugin.id);
  const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
  const capabilityCount = capabilities.length;
  const shape = deriveInspectShape({
    capabilityCount,
    cliCount: plugin.cliCommands.length,
    commandCount: plugin.commands.length,
    customHookCount: customHooks.length,
    gatewayMethodCount: plugin.gatewayMethods.length,
    httpRouteCount: plugin.httpRoutes,
    serviceCount: plugin.services.length,
    toolCount: tools.length,
    typedHookCount: typedHooks.length,
  });

  // Populate MCP server info for bundle-format plugins with a known rootDir.
  let mcpServers: PluginInspectReport["mcpServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const mcpSupport = inspectBundleMcpRuntimeSupport({
      bundleFormat: plugin.bundleFormat,
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
    });
    mcpServers = [
      ...mcpSupport.supportedServerNames.map((name) => ({
        hasStdioTransport: true,
        name,
      })),
      ...mcpSupport.unsupportedServerNames.map((name) => ({
        hasStdioTransport: false,
        name,
      })),
    ];
  }

  // Populate LSP server info for bundle-format plugins with a known rootDir.
  let lspServers: PluginInspectReport["lspServers"] = [];
  if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
    const lspSupport = inspectBundleLspRuntimeSupport({
      bundleFormat: plugin.bundleFormat,
      pluginId: plugin.id,
      rootDir: plugin.rootDir,
    });
    lspServers = [
      ...lspSupport.supportedServerNames.map((name) => ({
        hasStdioTransport: true,
        name,
      })),
      ...lspSupport.unsupportedServerNames.map((name) => ({
        hasStdioTransport: false,
        name,
      })),
    ];
  }

  const usesLegacyBeforeAgentStart = typedHooks.some(
    (entry) => entry.name === "before_agent_start",
  );
  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    usesLegacyBeforeAgentStart,
  });
  return {
    bundleCapabilities: plugin.bundleCapabilities ?? [],
    capabilities,
    capabilityCount,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    cliCommands: [...plugin.cliCommands],
    commands: [...plugin.commands],
    compatibility,
    customHooks,
    diagnostics,
    gatewayMethods: [...plugin.gatewayMethods],
    httpRouteCount: plugin.httpRoutes,
    lspServers,
    mcpServers,
    plugin,
    policy: {
      allowModelOverride: policyEntry?.subagent?.allowModelOverride,
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
      hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
    },
    services: [...plugin.services],
    shape,
    tools,
    typedHooks,
    usesLegacyBeforeAgentStart,
    workspaceDir: report.workspaceDir,
  };
}

export function buildAllPluginInspectReports(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport[] {
  const rawConfig = params?.config ?? loadConfig();
  const report =
    params?.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      env: params?.env,
      workspaceDir: params?.workspaceDir,
    });

  return report.plugins
    .map((plugin) =>
      buildPluginInspectReport({
        config: rawConfig,
        id: plugin.id,
        report,
      }),
    )
    .filter((entry): entry is PluginInspectReport => entry !== null);
}

export function buildPluginCompatibilityWarnings(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): string[] {
  return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}

export function buildPluginCompatibilityNotices(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginCompatibilityNotice[] {
  return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}

export function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string {
  return `${notice.pluginId} ${notice.message}`;
}

export function summarizePluginCompatibility(
  notices: PluginCompatibilityNotice[],
): PluginCompatibilitySummary {
  return {
    noticeCount: notices.length,
    pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
  };
}
