import path from "node:path";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { registerContextEngineForOwner } from "../context-engine/registry.js";
import type { OperatorScope } from "../gateway/method-scopes.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { HookEntry } from "../hooks/types.js";
import {
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginApi } from "./api-builder.js";
import { registerPluginCommand, validatePluginCommandDefinition } from "./command-registration.js";
import {
  getRegisteredCompactionProvider,
  registerCompactionProvider,
} from "./compaction-provider.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import { registerPluginInteractiveHandler } from "./interactive-registry.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryPromptSupplement,
  registerMemoryRuntime,
} from "./memory-state.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type {
  PluginCliBackendRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginConversationBindingResolvedHandlerRegistration,
  PluginHookRegistration,
  PluginMemoryEmbeddingProviderRegistration,
  PluginNodeHostCommandRegistration,
  PluginProviderRegistration,
  PluginRecord,
  PluginRegistry,
  PluginRegistryParams,
  PluginReloadRegistration,
  PluginSecurityAuditCollectorRegistration,
  PluginServiceRegistration,
  PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration,
} from "./registry-types.js";
import { withPluginRuntimePluginIdScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import {
  isPluginHookName,
  isPromptInjectionHookName,
  stripPromptMutationFieldsFromLegacyHookResult,
} from "./types.js";
import type {
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawPluginHookOptions,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginConversationBindingResolvedEvent,
  PluginDiagnostic,
  PluginHookHandlerMap,
  PluginHookName,
  PluginLogger,
  PluginRegistrationMode,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  PluginHookRegistration as TypedPluginHookRegistration,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};
interface PluginOwnedProviderRegistration<T extends { id: string }> {
  pluginId: string;
  pluginName?: string;
  provider: T;
  source: string;
  rootDir?: string;
}

export type {
  PluginChannelRegistration,
  PluginChannelSetupRegistration,
  PluginCliBackendRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginConversationBindingResolvedHandlerRegistration,
  PluginHookRegistration,
  PluginMemoryEmbeddingProviderRegistration,
  PluginNodeHostCommandRegistration,
  PluginProviderRegistration,
  PluginRecord,
  PluginRegistry,
  PluginRegistryParams,
  PluginReloadRegistration,
  PluginSecurityAuditCollectorRegistration,
  PluginServiceRegistration,
  PluginToolRegistration,
  PluginSpeechProviderRegistration,
  PluginRealtimeTranscriptionProviderRegistration,
  PluginRealtimeVoiceProviderRegistration,
  PluginMediaUnderstandingProviderRegistration,
  PluginImageGenerationProviderRegistration,
  PluginVideoGenerationProviderRegistration,
  PluginMusicGenerationProviderRegistration,
  PluginWebFetchProviderRegistration,
  PluginWebSearchProviderRegistration,
} from "./registry-types.js";

interface PluginTypedHookPolicy {
  allowPromptInjection?: boolean;
}

const constrainLegacyPromptInjectionHook =
  (
    handler: PluginHookHandlerMap["before_agent_start"],
  ): PluginHookHandlerMap["before_agent_start"] =>
  (event, ctx) => {
    const result = handler(event, ctx);
    if (result && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).then((resolved) =>
        stripPromptMutationFieldsFromLegacyHookResult(resolved),
      );
    }
    return stripPromptMutationFieldsFromLegacyHookResult(result);
  };

export { createEmptyPluginRegistry } from "./registry-empty.js";

const ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY = Symbol.for("openclaw.activePluginHookRegistrations");
const activePluginHookRegistrations = resolveGlobalSingleton<
  Map<string, { event: string; handler: Parameters<typeof registerInternalHook>[1] }[]>
>(ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY, () => new Map());

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    const names = opts?.names ?? (opts?.name ? [opts.name] : []);
    const optional = opts?.optional === true;
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: OpenClawPluginToolContext) => tool;

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = names.map((name) => name.trim()).filter(Boolean);
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      factory,
      names: normalized,
      optional,
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
  ) => {
    const eventList = Array.isArray(events) ? events : [events];
    const normalizedEvents = eventList.map((event) => event.trim()).filter(Boolean);
    const entry = opts?.entry ?? null;
    const name = entry?.hook.name ?? opts?.name?.trim();
    if (!name) {
      pushDiagnostic({
        level: "warn",
        message: "hook registration missing name",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existingHook = registry.hooks.find((entry) => entry.entry.hook.name === name);
    if (existingHook) {
      pushDiagnostic({
        level: "error",
        message: `hook already registered: ${name} (${existingHook.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            description,
            name,
            pluginId: record.id,
            source: "openclaw-plugin",
          },
          metadata: {
            ...entry.metadata,
            events: normalizedEvents,
          },
        }
      : {
          frontmatter: {},
          hook: {
            baseDir: path.dirname(record.source),
            description,
            filePath: record.source,
            handlerPath: record.source,
            name,
            pluginId: record.id,
            source: "openclaw-plugin",
          },
          invocation: { enabled: true },
          metadata: { events: normalizedEvents },
        };

    record.hookNames.push(name);
    registry.hooks.push({
      entry: hookEntry,
      events: normalizedEvents,
      pluginId: record.id,
      source: record.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled !== false;
    if (
      !registryParams.activateGlobalSideEffects ||
      !hookSystemEnabled ||
      opts?.register === false
    ) {
      return;
    }

    const previousRegistrations = activePluginHookRegistrations.get(name) ?? [];
    for (const registration of previousRegistrations) {
      unregisterInternalHook(registration.event, registration.handler);
    }

    const nextRegistrations: {
      event: string;
      handler: Parameters<typeof registerInternalHook>[1];
    }[] = [];
    for (const event of normalizedEvents) {
      registerInternalHook(event, handler);
      nextRegistrations.push({ event, handler });
    }
    activePluginHookRegistrations.set(name, nextRegistrations);
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope },
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      pushDiagnostic({
        level: "error",
        message: `gateway method already registered: ${trimmed}`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    registry.gatewayHandlers[trimmed] = handler;
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      pushDiagnostic({
        level: "warn",
        message: `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
        pluginId: record.id,
        source: record.source,
      });
    }
    const effectiveScope = normalizedScope.scope;
    if (effectiveScope) {
      registry.gatewayMethodScopes ??= {};
      registry.gatewayMethodScopes[trimmed] = effectiveScope;
    }
    record.gatewayMethods.push(trimmed);
  };

  const describeHttpRouteOwner = (entry: PluginHttpRouteRegistration): string => {
    const plugin = normalizeOptionalString(entry.pluginId) || "unknown-plugin";
    const source = normalizeOptionalString(entry.source) || "unknown-source";
    return `${plugin} (${source})`;
  };

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const normalizedPath = normalizePluginHttpPath(params.path);
    if (!normalizedPath) {
      pushDiagnostic({
        level: "warn",
        message: "http route registration missing path",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    if (params.auth !== "gateway" && params.auth !== "plugin") {
      pushDiagnostic({
        level: "error",
        message: `http route registration missing or invalid auth: ${normalizedPath}`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const match = params.match ?? "exact";
    const overlappingRoute = findOverlappingPluginHttpRoute(registry.httpRoutes, {
      match,
      path: normalizedPath,
    });
    if (overlappingRoute && overlappingRoute.auth !== params.auth) {
      pushDiagnostic({
        level: "error",
        message:
          `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) ` +
          `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
          `owned by ${describeHttpRouteOwner(overlappingRoute)}`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existingIndex = registry.httpRoutes.findIndex(
      (entry) => entry.path === normalizedPath && entry.match === match,
    );
    if (existingIndex !== -1) {
      const existing = registry.httpRoutes[existingIndex];
      if (!existing) {
        return;
      }
      if (!params.replaceExisting) {
        pushDiagnostic({
          level: "error",
          message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`,
          pluginId: record.id,
          source: record.source,
        });
        return;
      }
      if (existing.pluginId && existing.pluginId !== record.id) {
        pushDiagnostic({
          level: "error",
          message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`,
          pluginId: record.id,
          source: record.source,
        });
        return;
      }
      registry.httpRoutes[existingIndex] = {
        pluginId: record.id,
        path: normalizedPath,
        handler: params.handler,
        auth: params.auth,
        match,
        ...(params.gatewayRuntimeScopeSurface
          ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
          : {}),
        source: record.source,
      };
      return;
    }
    record.httpRoutes += 1;
    registry.httpRoutes.push({
      pluginId: record.id,
      path: normalizedPath,
      handler: params.handler,
      auth: params.auth,
      match,
      ...(params.gatewayRuntimeScopeSurface
        ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
        : {}),
      source: record.source,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
    mode: PluginRegistrationMode = "full",
  ) => {
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const { plugin } = normalized;
    const id =
      normalizeOptionalString(plugin?.id) ?? normalizeStringifiedOptionalString(plugin?.id) ?? "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        message: "channel registration missing id",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existingRuntime = registry.channels.find((entry) => entry.plugin.id === id);
    if (mode !== "setup-only" && existingRuntime) {
      pushDiagnostic({
        level: "error",
        message: `channel already registered: ${id} (${existingRuntime.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    if (existingSetup) {
      pushDiagnostic({
        level: "error",
        message: `channel setup already registered: ${id} (${existingSetup.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    record.channelIds.push(id);
    registry.channelSetups.push({
      enabled: record.enabled,
      plugin,
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
    if (mode === "setup-only") {
      return;
    }
    registry.channels.push({
      plugin,
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const normalizedProvider = normalizeRegisteredProvider({
      pluginId: record.id,
      provider,
      pushDiagnostic,
      source: record.source,
    });
    if (!normalizedProvider) {
      return;
    }
    const { id } = normalizedProvider;
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        message: `provider already registered: ${id} (${existing.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    record.providerIds.push(id);
    registry.providers.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: normalizedProvider,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerCliBackend = (record: PluginRecord, backend: CliBackendPlugin) => {
    const id = backend.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        message: "cli backend registration missing id",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existing = (registry.cliBackends ?? []).find((entry) => entry.backend.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        message: `cli backend already registered: ${id} (${existing.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    (registry.cliBackends ??= []).push({
      backend: {
        ...backend,
        id,
      },
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
    record.cliBackendIds.push(id);
  };

  const registerUniqueProviderLike = <
    T extends { id: string },
    R extends PluginOwnedProviderRegistration<T>,
  >(params: {
    record: PluginRecord;
    provider: T;
    kindLabel: string;
    registrations: R[];
    ownedIds: string[];
  }) => {
    const id = params.provider.id.trim();
    const { record, kindLabel } = params;
    const missingLabel = `${kindLabel} registration missing id`;
    const duplicateLabel = `${kindLabel} already registered: ${id}`;
    if (!id) {
      pushDiagnostic({
        level: "error",
        message: missingLabel,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existing = params.registrations.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        message: `${duplicateLabel} (${existing.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    params.ownedIds.push(id);
    params.registrations.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: params.provider,
      rootDir: record.rootDir,
      source: record.source,
    } as R);
  };

  const registerSpeechProvider = (record: PluginRecord, provider: SpeechProviderPlugin) => {
    registerUniqueProviderLike({
      kindLabel: "speech provider",
      ownedIds: record.speechProviderIds,
      provider,
      record,
      registrations: registry.speechProviders,
    });
  };

  const registerRealtimeTranscriptionProvider = (
    record: PluginRecord,
    provider: RealtimeTranscriptionProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      kindLabel: "realtime transcription provider",
      ownedIds: record.realtimeTranscriptionProviderIds,
      provider,
      record,
      registrations: registry.realtimeTranscriptionProviders,
    });
  };

  const registerRealtimeVoiceProvider = (
    record: PluginRecord,
    provider: RealtimeVoiceProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      kindLabel: "realtime voice provider",
      ownedIds: record.realtimeVoiceProviderIds,
      provider,
      record,
      registrations: registry.realtimeVoiceProviders,
    });
  };

  const registerMediaUnderstandingProvider = (
    record: PluginRecord,
    provider: MediaUnderstandingProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      kindLabel: "media provider",
      ownedIds: record.mediaUnderstandingProviderIds,
      provider,
      record,
      registrations: registry.mediaUnderstandingProviders,
    });
  };

  const registerImageGenerationProvider = (
    record: PluginRecord,
    provider: ImageGenerationProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      kindLabel: "image-generation provider",
      ownedIds: record.imageGenerationProviderIds,
      provider,
      record,
      registrations: registry.imageGenerationProviders,
    });
  };

  const registerVideoGenerationProvider = (
    record: PluginRecord,
    provider: VideoGenerationProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      kindLabel: "video-generation provider",
      ownedIds: record.videoGenerationProviderIds,
      provider,
      record,
      registrations: registry.videoGenerationProviders,
    });
  };

  const registerMusicGenerationProvider = (
    record: PluginRecord,
    provider: MusicGenerationProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      kindLabel: "music-generation provider",
      ownedIds: record.musicGenerationProviderIds,
      provider,
      record,
      registrations: registry.musicGenerationProviders,
    });
  };

  const registerWebFetchProvider = (record: PluginRecord, provider: WebFetchProviderPlugin) => {
    registerUniqueProviderLike({
      kindLabel: "web fetch provider",
      ownedIds: record.webFetchProviderIds,
      provider,
      record,
      registrations: registry.webFetchProviders,
    });
  };

  const registerWebSearchProvider = (record: PluginRecord, provider: WebSearchProviderPlugin) => {
    registerUniqueProviderLike({
      kindLabel: "web search provider",
      ownedIds: record.webSearchProviderIds,
      provider,
      record,
      registrations: registry.webSearchProviders,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: { commands?: string[]; descriptors?: OpenClawPluginCliCommandDescriptor[] },
  ) => {
    const descriptors = (opts?.descriptors ?? [])
      .map((descriptor) => ({
        description: descriptor.description.trim(),
        hasSubcommands: descriptor.hasSubcommands,
        name: descriptor.name.trim(),
      }))
      .filter((descriptor) => descriptor.name && descriptor.description);
    const commands = [
      ...(opts?.commands ?? []),
      ...descriptors.map((descriptor) => descriptor.name),
    ]
      .map((cmd) => cmd.trim())
      .filter(Boolean);
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        message: "cli registration missing explicit commands metadata",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    const existing = registry.cliRegistrars.find((entry) =>
      entry.commands.some((command) => commands.includes(command)),
    );
    if (existing) {
      const overlap = commands.find((command) => existing.commands.includes(command));
      pushDiagnostic({
        level: "error",
        message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    record.cliCommands.push(...commands);
    registry.cliRegistrars.push({
      commands,
      descriptors,
      pluginId: record.id,
      pluginName: record.name,
      register: registrar,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const reservedNodeHostCommands = new Set<string>([
    ...NODE_SYSTEM_RUN_COMMANDS,
    ...NODE_EXEC_APPROVALS_COMMANDS,
    NODE_SYSTEM_NOTIFY_COMMAND,
  ]);

  const registerReload = (record: PluginRecord, registration: OpenClawPluginReloadRegistration) => {
    const normalize = (values?: string[]) =>
      (values ?? []).map((value) => value.trim()).filter(Boolean);
    const normalized: OpenClawPluginReloadRegistration = {
      hotPrefixes: normalize(registration.hotPrefixes),
      noopPrefixes: normalize(registration.noopPrefixes),
      restartPrefixes: normalize(registration.restartPrefixes),
    };
    if (
      (normalized.restartPrefixes?.length ?? 0) === 0 &&
      (normalized.hotPrefixes?.length ?? 0) === 0 &&
      (normalized.noopPrefixes?.length ?? 0) === 0
    ) {
      pushDiagnostic({
        level: "warn",
        message: "reload registration missing prefixes",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    registry.reloads ??= [];
    registry.reloads.push({
      pluginId: record.id,
      pluginName: record.name,
      registration: normalized,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerNodeHostCommand = (
    record: PluginRecord,
    nodeCommand: OpenClawPluginNodeHostCommand,
  ) => {
    const command = nodeCommand.command.trim();
    if (!command) {
      pushDiagnostic({
        level: "error",
        message: "node host command registration missing command",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    if (reservedNodeHostCommands.has(command)) {
      pushDiagnostic({
        level: "error",
        message: `node host command reserved by core: ${command}`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    registry.nodeHostCommands ??= [];
    const existing = registry.nodeHostCommands.find((entry) => entry.command.command === command);
    if (existing) {
      pushDiagnostic({
        level: "error",
        message: `node host command already registered: ${command} (${existing.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    registry.nodeHostCommands.push({
      command: {
        ...nodeCommand,
        cap: normalizeOptionalString(nodeCommand.cap),
        command,
      },
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerSecurityAuditCollector = (
    record: PluginRecord,
    collector: OpenClawPluginSecurityAuditCollector,
  ) => {
    registry.securityAuditCollectors ??= [];
    registry.securityAuditCollectors.push({
      collector,
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerService = (record: PluginRecord, service: OpenClawPluginService) => {
    const id = service.id.trim();
    if (!id) {
      return;
    }
    const existing = registry.services.find((entry) => entry.service.id === id);
    if (existing) {
      // Idempotent: the same plugin can hit registration twice across snapshot vs
      // Activating loads (see #62033). Keep the first registration.
      if (existing.pluginId === record.id) {
        return;
      }
      pushDiagnostic({
        level: "error",
        message: `service already registered: ${id} (${existing.pluginId})`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      service,
      source: record.source,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const name = command.name.trim();
    if (!name) {
      pushDiagnostic({
        level: "error",
        message: "command registration missing name",
        pluginId: record.id,
        source: record.source,
      });
      return;
    }

    // For snapshot (non-activating) loads, record the command locally without touching the
    // global plugin command registry so running gateway commands stay intact.
    // We still validate the command definition so diagnostics match the real activation path.
    // NOTE: cross-plugin duplicate command detection is intentionally skipped here because
    // Snapshot registries are isolated and never write to the global command table. Conflicts
    // Will surface when the plugin is loaded via the normal activation path at gateway startup.
    if (!registryParams.activateGlobalSideEffects) {
      const validationError = validatePluginCommandDefinition(command);
      if (validationError) {
        pushDiagnostic({
          level: "error",
          message: `command registration failed: ${validationError}`,
          pluginId: record.id,
          source: record.source,
        });
        return;
      }
    } else {
      const result = registerPluginCommand(record.id, command, {
        pluginName: record.name,
        pluginRoot: record.rootDir,
      });
      if (!result.ok) {
        pushDiagnostic({
          level: "error",
          message: `command registration failed: ${result.error}`,
          pluginId: record.id,
          source: record.source,
        });
        return;
      }
    }

    record.commands.push(name);
    registry.commands.push({
      command,
      pluginId: record.id,
      pluginName: record.name,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
    policy?: PluginTypedHookPolicy,
  ) => {
    if (!isPluginHookName(hookName)) {
      pushDiagnostic({
        level: "warn",
        message: `unknown typed hook "${String(hookName)}" ignored`,
        pluginId: record.id,
        source: record.source,
      });
      return;
    }
    let effectiveHandler = handler;
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(hookName)) {
      if (hookName === "before_prompt_build") {
        pushDiagnostic({
          level: "warn",
          message: `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
          pluginId: record.id,
          source: record.source,
        });
        return;
      }
      if (hookName === "before_agent_start") {
        pushDiagnostic({
          level: "warn",
          message: `typed hook "${hookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
          pluginId: record.id,
          source: record.source,
        });
        effectiveHandler = constrainLegacyPromptInjectionHook(
          handler as PluginHookHandlerMap["before_agent_start"],
        ) as PluginHookHandlerMap[K];
      }
    }
    record.hookCount += 1;
    registry.typedHooks.push({
      handler: effectiveHandler,
      hookName,
      pluginId: record.id,
      priority: opts?.priority,
      source: record.source,
    } as TypedPluginHookRegistration);
  };

  const registerConversationBindingResolvedHandler = (
    record: PluginRecord,
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => {
    registry.conversationBindingResolvedHandlers.push({
      handler,
      pluginId: record.id,
      pluginName: record.name,
      pluginRoot: record.rootDir,
      rootDir: record.rootDir,
      source: record.source,
    });
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    debug: logger.debug,
    error: logger.error,
    info: logger.info,
    warn: logger.warn,
  });

  const pluginRuntimeById = new Map<string, PluginRuntime>();

  const resolvePluginRuntime = (pluginId: string): PluginRuntime => {
    const cached = pluginRuntimeById.get(pluginId);
    if (cached) {
      return cached;
    }
    const runtime = new Proxy(registryParams.runtime, {
      get(target, prop, receiver) {
        if (prop !== "subagent") {
          return Reflect.get(target, prop, receiver);
        }
        const subagent = Reflect.get(target, prop, receiver);
        return {
          deleteSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.deleteSession(params)),
          getSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSession(params)),
          getSessionMessages: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
          run: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params)),
          waitForRun: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
        } satisfies PluginRuntime["subagent"];
      },
    });
    pluginRuntimeById.set(pluginId, runtime);
    return runtime;
  };

  const createApi = (
    record: PluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
      registrationMode?: PluginRegistrationMode;
    },
  ): OpenClawPluginApi => {
    const registrationMode = params.registrationMode ?? "full";
    return buildPluginApi({
      config: params.config,
      description: record.description,
      handlers: {
        ...(registrationMode === "full"
          ? {
              on: (hookName, handler, opts) =>
                registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
              onConversationBindingResolved: (handler) =>
                registerConversationBindingResolvedHandler(record, handler),
              registerCliBackend: (backend) => registerCliBackend(record, backend),
              registerCommand: (command) => registerCommand(record, command),
              registerCompactionProvider: (
                provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
              ) => {
                const existing = getRegisteredCompactionProvider(provider.id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `compaction provider already registered: ${provider.id}${ownerDetail}`,
                  });
                  return;
                }
                registerCompactionProvider(provider, { ownerPluginId: record.id });
              },
              registerContextEngine: (id, factory) => {
                if (id === defaultSlotIdForKey("contextEngine")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine id reserved by core: ${id}`,
                  });
                  return;
                }
                const result = registerContextEngineForOwner(id, factory, `plugin:${record.id}`, {
                  allowSameOwnerRefresh: true,
                });
                if (!result.ok) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine already registered: ${id} (${result.existingOwner})`,
                  });
                }
              },
              registerGatewayMethod: (method, handler, opts) =>
                registerGatewayMethod(record, method, handler, opts),
              registerHook: (events, handler, opts) =>
                registerHook(record, events, handler, opts, params.config),
              registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
              registerImageGenerationProvider: (provider) =>
                registerImageGenerationProvider(record, provider),
              registerInteractiveHandler: (registration) => {
                const result = registerPluginInteractiveHandler(record.id, registration, {
                  pluginName: record.name,
                  pluginRoot: record.rootDir,
                });
                if (!result.ok) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: result.error ?? "interactive handler registration failed",
                  });
                }
              },
              registerMediaUnderstandingProvider: (provider) =>
                registerMediaUnderstandingProvider(record, provider),
              registerMemoryCapability: (capability) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory capability",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory capability registration",
                  });
                  return;
                }
                registerMemoryCapability(record.id, capability);
              },
              registerMemoryCorpusSupplement: (supplement) => {
                registerMemoryCorpusSupplement(record.id, supplement);
              },
              registerMemoryEmbeddingProvider: (adapter) => {
                if (hasKind(record.kind, "memory")) {
                  if (
                    Array.isArray(record.kind) &&
                    record.kind.length > 1 &&
                    !record.memorySlotSelected
                  ) {
                    pushDiagnostic({
                      level: "warn",
                      pluginId: record.id,
                      source: record.source,
                      message:
                        "dual-kind plugin not selected for memory slot; skipping memory embedding provider registration",
                    });
                    return;
                  }
                } else if (
                  !(record.contracts?.memoryEmbeddingProviders ?? []).includes(adapter.id)
                ) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`,
                  });
                  return;
                }
                const existing = getRegisteredMemoryEmbeddingProvider(adapter.id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`,
                  });
                  return;
                }
                registerMemoryEmbeddingProvider(adapter, {
                  ownerPluginId: record.id,
                });
                registry.memoryEmbeddingProviders.push({
                  pluginId: record.id,
                  pluginName: record.name,
                  provider: adapter,
                  source: record.source,
                  rootDir: record.rootDir,
                });
              },
              registerMemoryFlushPlan: (resolver) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory flush plan",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory flush plan registration",
                  });
                  return;
                }
                registerMemoryFlushPlanResolver(resolver);
              },
              registerMemoryPromptSection: (builder) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory prompt section",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory prompt section registration",
                  });
                  return;
                }
                registerMemoryPromptSection(builder);
              },
              registerMemoryPromptSupplement: (builder) => {
                registerMemoryPromptSupplement(record.id, builder);
              },
              registerMemoryRuntime: (runtime) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory runtime",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory runtime registration",
                  });
                  return;
                }
                registerMemoryRuntime(runtime);
              },
              registerMusicGenerationProvider: (provider) =>
                registerMusicGenerationProvider(record, provider),
              registerNodeHostCommand: (command) => registerNodeHostCommand(record, command),
              registerProvider: (provider) => registerProvider(record, provider),
              registerRealtimeTranscriptionProvider: (provider) =>
                registerRealtimeTranscriptionProvider(record, provider),
              registerRealtimeVoiceProvider: (provider) =>
                registerRealtimeVoiceProvider(record, provider),
              registerReload: (registration) => registerReload(record, registration),
              registerSecurityAuditCollector: (collector) =>
                registerSecurityAuditCollector(record, collector),
              registerService: (service) => registerService(record, service),
              registerSpeechProvider: (provider) => registerSpeechProvider(record, provider),
              registerTool: (tool, opts) => registerTool(record, tool, opts),
              registerVideoGenerationProvider: (provider) =>
                registerVideoGenerationProvider(record, provider),
              registerWebFetchProvider: (provider) => registerWebFetchProvider(record, provider),
              registerWebSearchProvider: (provider) => registerWebSearchProvider(record, provider),
            }
          : {}),
        // Allow setup-only/setup-runtime paths to surface parse-time CLI metadata
        // Without opting into the wider full-registration surface.
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
        registerChannel: (registration) => registerChannel(record, registration, registrationMode),
      },
      id: record.id,
      logger: normalizeLogger(registryParams.logger),
      name: record.name,
      pluginConfig: params.pluginConfig,
      registrationMode,
      resolvePath: (input: string) => resolveUserPath(input),
      rootDir: record.rootDir,
      runtime: resolvePluginRuntime(record.id),
      source: record.source,
      version: record.version,
    });
  };

  return {
    createApi,
    pushDiagnostic,
    registerChannel,
    registerCli,
    registerCliBackend,
    registerCommand,
    registerGatewayMethod,
    registerHook,
    registerImageGenerationProvider,
    registerMediaUnderstandingProvider,
    registerMusicGenerationProvider,
    registerNodeHostCommand,
    registerProvider,
    registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider,
    registerReload,
    registerSecurityAuditCollector,
    registerService,
    registerSpeechProvider,
    registerTool,
    registerTypedHook,
    registerVideoGenerationProvider,
    registerWebSearchProvider,
    registry,
  };
}
