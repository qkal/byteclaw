import type { PluginLoadResult } from "./loader.js";
import type { PluginRecord } from "./registry.js";
import type { PluginCompatibilityNotice, PluginStatusReport } from "./status.js";
import type { PluginHookName } from "./types.js";

export const LEGACY_BEFORE_AGENT_START_MESSAGE =
  "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.";
export const HOOK_ONLY_MESSAGE =
  "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.";

export function createCompatibilityNotice(
  params: Pick<PluginCompatibilityNotice, "pluginId" | "code">,
): PluginCompatibilityNotice {
  if (params.code === "legacy-before-agent-start") {
    return {
      code: params.code,
      message: LEGACY_BEFORE_AGENT_START_MESSAGE,
      pluginId: params.pluginId,
      severity: "warn",
    };
  }

  return {
    code: params.code,
    message: HOOK_ONLY_MESSAGE,
    pluginId: params.pluginId,
    severity: "info",
  };
}

export function createPluginRecord(
  overrides: Partial<PluginRecord> & Pick<PluginRecord, "id">,
): PluginRecord {
  const { id, ...rest } = overrides;
  return {
    activated: overrides.activated ?? overrides.enabled ?? true,
    activationReason: overrides.activationReason,
    activationSource:
      overrides.activationSource ?? ((overrides.enabled ?? true) ? "explicit" : "disabled"),
    channelIds: [],
    cliBackendIds: [],
    cliCommands: [],
    commands: [],
    configSchema: false,
    description: overrides.description ?? "",
    enabled: overrides.enabled ?? true,
    explicitlyEnabled: overrides.explicitlyEnabled ?? overrides.enabled ?? true,
    gatewayMethods: [],
    hookCount: 0,
    hookNames: [],
    httpRoutes: 0,
    id,
    imageGenerationProviderIds: [],
    mediaUnderstandingProviderIds: [],
    memoryEmbeddingProviderIds: [],
    musicGenerationProviderIds: [],
    name: overrides.name ?? id,
    origin: overrides.origin ?? "workspace",
    providerIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    services: [],
    source: overrides.source ?? `/tmp/${id}/index.ts`,
    speechProviderIds: [],
    status: overrides.status ?? "loaded",
    toolNames: [],
    videoGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    ...rest,
  };
}

export function createTypedHook(params: {
  pluginId: string;
  hookName: PluginHookName;
  source?: string;
}): PluginLoadResult["typedHooks"][number] {
  return {
    handler: () => undefined,
    hookName: params.hookName,
    pluginId: params.pluginId,
    source: params.source ?? `/tmp/${params.pluginId}/index.ts`,
  };
}

export function createCustomHook(params: {
  pluginId: string;
  events: string[];
  name?: string;
}): PluginLoadResult["hooks"][number] {
  const source = `/tmp/${params.pluginId}/handler.ts`;
  return {
    entry: {
      frontmatter: {},
      hook: {
        baseDir: `/tmp/${params.pluginId}`,
        description: "",
        filePath: `/tmp/${params.pluginId}/HOOK.md`,
        handlerPath: source,
        name: params.name ?? "legacy",
        pluginId: params.pluginId,
        source: "openclaw-plugin",
      },
    },
    events: params.events,
    pluginId: params.pluginId,
    source,
  };
}

export function createPluginLoadResult(
  overrides: Partial<PluginLoadResult> & Pick<PluginLoadResult, "plugins"> = { plugins: [] },
): PluginLoadResult {
  const { plugins, realtimeTranscriptionProviders, realtimeVoiceProviders, ...rest } = overrides;
  return {
    plugins,
    diagnostics: [],
    channels: [],
    channelSetups: [],
    providers: [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    memoryEmbeddingProviders: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    httpRoutes: [],
    gatewayHandlers: {},
    cliRegistrars: [],
    services: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
    ...rest,
    realtimeTranscriptionProviders: realtimeTranscriptionProviders ?? [],
    realtimeVoiceProviders: realtimeVoiceProviders ?? [],
  };
}

export function createPluginStatusReport(
  overrides: Partial<PluginStatusReport> & Pick<PluginStatusReport, "plugins">,
): PluginStatusReport {
  const { workspaceDir, ...loadResultOverrides } = overrides;
  return {
    workspaceDir,
    ...createPluginLoadResult(loadResultOverrides),
  };
}
