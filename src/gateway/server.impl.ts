import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/runs.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.js";
import {
  type OpenClawConfig,
  applyConfigOverrides,
  getRuntimeConfig,
  isNixMode,
  loadConfig,
  readConfigFileSnapshot,
  registerConfigWriteListener,
  writeConfigFile,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { clearAgentRunContext } from "../infra/agent-events.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { logAcceptedEnvOption } from "../infra/env.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  getInspectableTaskRegistrySummary,
  stopTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import { runSetupWizard } from "../wizard/setup.js";
import { type AuthRateLimiter, createAuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createChannelManager } from "./server-channels.js";
import { createGatewayCloseHandler, runGatewayClosePrelude } from "./server-close.js";
import { resolveGatewayControlUiRootState } from "./server-control-ui-root.js";
import { buildGatewayCronService } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { type GatewayServerLiveState, createGatewayServerLiveState } from "./server-live-state.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import { reloadDeferredGatewayPlugins } from "./server-plugin-bootstrap.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import { startManagedGatewayConfigReloader } from "./server-reload-handlers.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import { startGatewayRuntimeServices } from "./server-runtime-services.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import {
  type SharedGatewaySessionGenerationState,
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
} from "./server-shared-auth-generation.js";
import {
  createRuntimeSecretsActivator,
  loadGatewayStartupConfigSnapshot,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import { prepareGatewayPluginBootstrap } from "./server-startup-plugins.js";
import { startGatewayEarlyRuntime, startGatewayPostAttachRuntime } from "./server-startup.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { resolveHookClientIpConfig } from "./server/hooks.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");

let cachedChannelRuntime: ReturnType<typeof createPluginRuntime>["channel"] | null = null;

function getChannelRuntime() {
  cachedChannelRuntime ??= createPluginRuntime().channel;
  return cachedChannelRuntime;
}

const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  // Browser-origin WS auth attempts always use loopback-non-exempt throttling.
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { browserRateLimiter, rateLimiter };
}

export interface GatewayServer {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
}

export interface GatewayServerOptions {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the setup wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  /**
   * Optional startup timestamp used for concise readiness logging.
   */
  startupStartedAt?: number;
}

export async function startGatewayServer(
  port = 18_789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const minimalTestGateway =
    process.env.VITEST === "1" && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  // Ensure all default port derivations (browser/canvas) see the actual runtime port.
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    description: "raw stream logging enabled",
    key: "OPENCLAW_RAW_STREAM",
  });
  logAcceptedEnvOption({
    description: "raw stream log path override",
    key: "OPENCLAW_RAW_STREAM_PATH",
  });

  const configSnapshot = await loadGatewayStartupConfigSnapshot({
    log,
    minimalTestGateway,
  });

  const emitSecretsStateEvent = (
    code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED",
    message: string,
    cfg: OpenClawConfig,
  ) => {
    enqueueSystemEvent(`[${code}] ${message}`, {
      contextKey: code,
      sessionKey: resolveMainSessionKey(cfg),
    });
  };
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    emitStateEvent: emitSecretsStateEvent,
    logSecrets,
  });

  let cfgAtStart: OpenClawConfig;
  let startupInternalWriteHash: string | null = null;
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  const authBootstrap = await prepareGatewayStartupConfig({
    activateRuntimeSecrets,
    authOverride: opts.auth,
    configSnapshot,
    tailscaleOverride: opts.tailscale,
  });
  cfgAtStart = authBootstrap.cfg;
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(undefined, { getConfig: getRuntimeConfig });
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getInspectableTaskRegistrySummary().active,
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // Non-loopback installs that upgraded to v2026.2.26+ without required origins.
  const controlUiSeed = minimalTestGateway
    ? { config: cfgAtStart, persistedAllowedOriginsSeed: false }
    : await maybeSeedControlUiAllowedOriginsAtStartup({
        config: cfgAtStart,
        log,
        writeConfig: writeConfigFile,
      });
  cfgAtStart = controlUiSeed.config;
  if (authBootstrap.persistedGeneratedToken || controlUiSeed.persistedAllowedOriginsSeed) {
    const startupSnapshot = await readConfigFileSnapshot();
    startupInternalWriteHash = startupSnapshot.hash ?? null;
  }
  const pluginBootstrap = await prepareGatewayPluginBootstrap({
    cfgAtStart,
    log,
    minimalTestGateway,
    startupRuntimeConfig,
  });
  const {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    baseMethods,
  } = pluginBootstrap;
  let { pluginRegistry, baseGatewayMethods } = pluginBootstrap;
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  const listActiveGatewayMethods = (nextBaseGatewayMethods: string[]) => [
    ...new Set([
      ...nextBaseGatewayMethods,
      ...listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []),
    ]),
  ];
  const runtimeConfig = await resolveGatewayRuntimeConfig({
    auth: opts.auth,
    bind: opts.bind,
    cfg: cfgAtStart,
    controlUiEnabled: opts.controlUiEnabled,
    host: opts.host,
    openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
    openResponsesEnabled: opts.openResponsesEnabled,
    port,
    tailscale: opts.tailscale,
  });
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  const getResolvedAuth = () =>
    resolveGatewayAuth({
      authConfig:
        getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth ?? getRuntimeConfig().gateway?.auth,
      authOverride: opts.auth,
      env: process.env,
      tailscaleMode,
    });
  const resolveSharedGatewaySessionGenerationForConfig = (config: OpenClawConfig) =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: config.gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
    );
  const resolveCurrentSharedGatewaySessionGeneration = () =>
    resolveSharedGatewaySessionGeneration(getResolvedAuth());
  const resolveSharedGatewaySessionGenerationForRuntimeSnapshot = () =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: getRuntimeConfig().gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
    );
  const sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState = {
    current: resolveCurrentSharedGatewaySessionGeneration(),
    required: null,
  };
  const initialHooksConfig = runtimeConfig.hooksConfig;
  const initialHookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
  const { canvasHostEnabled } = runtimeConfig;

  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  const controlUiRootState = await resolveGatewayControlUiRootState({
    controlUiEnabled,
    controlUiRootOverride,
    gatewayRuntime,
    log,
  });

  const wizardRunner = opts.wizardRunner ?? runSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let runtimeState: GatewayServerLiveState | null = null;
  const canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls"));
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const channelManager = createChannelManager({
    channelLogs,
    channelRuntimeEnvs,
    loadConfig: () =>
      applyPluginAutoEnable({
        config: loadConfig(),
        env: process.env,
      }).config,
    resolveChannelRuntime: getChannelRuntime,
  });
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
  });
  log.info("starting HTTP server...");
  const {
    canvasHost,
    releasePluginRouteRegistry,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    preauthConnectionBudget,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    chatDeltaLastBroadcastLen,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  } = await createGatewayRuntimeState({
    allowCanvasHostInTests: opts.allowCanvasHostInTests,
    bindHost,
    canvasHostEnabled,
    canvasRuntime,
    cfg: cfgAtStart,
    controlUiBasePath,
    controlUiEnabled,
    controlUiRoot: controlUiRootState,
    deps,
    gatewayTls,
    getHookClientIpConfig: () => runtimeState?.hookClientIpConfig ?? initialHookClientIpConfig,
    getReadiness,
    hooksConfig: () => runtimeState?.hooksConfig ?? initialHooksConfig,
    log,
    logCanvas,
    logHooks,
    logPlugins,
    openAiChatCompletionsConfig,
    openAiChatCompletionsEnabled,
    openResponsesConfig,
    openResponsesEnabled,
    pinChannelRegistry: !minimalTestGateway,
    pluginRegistry,
    port,
    rateLimiter: authRateLimiter,
    resolvedAuth,
    strictTransportSecurityHeader,
  });
  const {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    broadcastVoiceWakeChanged,
    hasMobileNodeConnected,
  } = createGatewayNodeSessionRuntime({ broadcast });
  applyGatewayLaneConcurrency(cfgAtStart);

  runtimeState = createGatewayServerLiveState({
    cronState: buildGatewayCronService({
      broadcast,
      cfg: cfgAtStart,
      deps,
    }),
    gatewayMethods: listActiveGatewayMethods(baseGatewayMethods),
    hookClientIpConfig: initialHookClientIpConfig,
    hooksConfig: initialHooksConfig,
  });
  deps.cron = runtimeState.cronState.cron;

  const runClosePrelude = async () =>
    await runGatewayClosePrelude({
      ...(diagnosticsEnabled ? { stopDiagnostics: stopDiagnosticHeartbeat } : {}),
      clearSkillsRefreshTimer: () => {
        if (!runtimeState?.skillsRefreshTimer) {
          return;
        }
        clearTimeout(runtimeState.skillsRefreshTimer);
        runtimeState.skillsRefreshTimer = null;
      },
      skillsChangeUnsub: runtimeState.skillsChangeUnsub,
      ...(authRateLimiter ? { disposeAuthRateLimiter: () => authRateLimiter.dispose() } : {}),
      disposeBrowserAuthRateLimiter: () => browserAuthRateLimiter.dispose(),
      stopModelPricingRefresh: runtimeState.stopModelPricingRefresh,
      stopChannelHealthMonitor: () => runtimeState?.channelHealthMonitor?.stop(),
      clearSecretsRuntimeSnapshot,
      closeMcpServer: async () => await runtimeState?.mcpServer?.close(),
    });
  const closeOnStartupFailure = async () => {
    await runClosePrelude();
    await createGatewayCloseHandler({
      agentUnsub: runtimeState.agentUnsub,
      bonjourStop: runtimeState.bonjourStop,
      broadcast,
      canvasHost,
      canvasHostServer,
      chatRunState,
      clients,
      configReloader: runtimeState.configReloader,
      cron: runtimeState.cronState.cron,
      dedupeCleanup: runtimeState.dedupeCleanup,
      healthInterval: runtimeState.healthInterval,
      heartbeatRunner: runtimeState.heartbeatRunner,
      heartbeatUnsub: runtimeState.heartbeatUnsub,
      httpServer,
      httpServers,
      lifecycleUnsub: runtimeState.lifecycleUnsub,
      mediaCleanup: runtimeState.mediaCleanup,
      nodePresenceTimers,
      pluginServices: runtimeState.pluginServices,
      releasePluginRouteRegistry,
      stopChannel,
      stopTaskRegistryMaintenance,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      tickInterval: runtimeState.tickInterval,
      transcriptUnsub: runtimeState.transcriptUnsub,
      updateCheckStop: runtimeState.stopGatewayUpdateCheck,
      wss,
    })({ reason: "gateway startup failed" });
  };

  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  try {
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway,
      cfgAtStart,
      port,
      gatewayTls,
      tailscaleMode,
      log,
      logDiscovery,
      nodeRegistry,
      broadcast,
      nodeSendToAllSubscribed,
      getPresenceVersion,
      getHealthVersion,
      refreshGatewayHealthSnapshot,
      logHealth,
      dedupe,
      chatAbortControllers,
      chatRunState,
      chatRunBuffers,
      chatDeltaSentAt,
      chatDeltaLastBroadcastLen,
      removeChatRun,
      agentRunSeq,
      nodeSendToSession,
      ...(typeof cfgAtStart.media?.ttlHours === "number"
        ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
        : {}),
      skillsRefreshDelayMs: runtimeState.skillsRefreshDelayMs,
      getSkillsRefreshTimer: () => runtimeState.skillsRefreshTimer,
      setSkillsRefreshTimer: (timer) => {
        runtimeState.skillsRefreshTimer = timer;
      },
      loadConfig,
    });
    runtimeState.mcpServer = earlyRuntime.mcpServer;
    runtimeState.bonjourStop = earlyRuntime.bonjourStop;
    runtimeState.skillsChangeUnsub = earlyRuntime.skillsChangeUnsub;
    if (earlyRuntime.maintenance) {
      runtimeState.tickInterval = earlyRuntime.maintenance.tickInterval;
      runtimeState.healthInterval = earlyRuntime.maintenance.healthInterval;
      runtimeState.dedupeCleanup = earlyRuntime.maintenance.dedupeCleanup;
      runtimeState.mediaCleanup = earlyRuntime.maintenance.mediaCleanup;
    }

    Object.assign(
      runtimeState,
      startGatewayEventSubscriptions({
        agentRunSeq,
        broadcast,
        broadcastToConnIds,
        chatAbortControllers,
        chatRunState,
        clearAgentRunContext,
        minimalTestGateway,
        nodeSendToSession,
        resolveSessionKeyForRun,
        sessionEventSubscribers,
        sessionMessageSubscribers,
        toolEventRecipients,
      }),
    );

    Object.assign(
      runtimeState,
      startGatewayRuntimeServices({
        cfgAtStart,
        channelManager,
        cron: runtimeState.cronState.cron,
        log,
        logCron,
        minimalTestGateway,
      }),
    );

    const { execApprovalManager, pluginApprovalManager, extraHandlers } = createGatewayAuxHandlers({
      activateRuntimeSecrets,
      clients,
      log,
      resolveSharedGatewaySessionGenerationForConfig,
      sharedGatewaySessionGenerationState,
    });

    const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

    const unavailableGatewayMethods = new Set<string>(minimalTestGateway ? [] : ["chat.history"]);
    const gatewayRequestContext = createGatewayRequestContext({
      addChatRun,
      agentRunSeq,
      broadcast,
      broadcastToConnIds,
      broadcastVoiceWakeChanged,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatRunBuffers: chatRunState.buffers,
      clients,
      dedupe,
      deps,
      enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => {
        enforceSharedGatewaySessionGenerationForConfigWrite({
          clients,
          nextConfig,
          resolveRuntimeSnapshotGeneration: resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
          state: sharedGatewaySessionGenerationState,
        });
      },
      execApprovalManager,
      findRunningWizard,
      getHealthCache,
      getHealthVersion,
      getRuntimeSnapshot,
      getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
      hasConnectedMobileNode: hasMobileNodeConnected,
      incrementPresenceVersion,
      loadGatewayModelCatalog,
      logGateway: log,
      logHealth,
      markChannelLoggedOut,
      nodeRegistry,
      nodeSendToAllSubscribed,
      nodeSendToSession,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      pluginApprovalManager,
      purgeWizardSession,
      refreshHealthSnapshot: refreshGatewayHealthSnapshot,
      registerToolEventRecipient: toolEventRecipients.add,
      removeChatRun,
      runtimeState,
      startChannel,
      stopChannel,
      subscribeSessionEvents: sessionEventSubscribers.subscribe,
      subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe,
      unavailableGatewayMethods,
      unsubscribeAllSessionEvents: (connId: string) => {
        sessionEventSubscribers.unsubscribe(connId);
        sessionMessageSubscribers.unsubscribeAll(connId);
      },
      unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
      unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe,
      wizardRunner,
      wizardSessions,
    });

    setFallbackGatewayContextResolver(() => gatewayRequestContext);

    if (!minimalTestGateway) {
      if (deferredConfiguredChannelPluginIds.length > 0) {
        ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = reloadDeferredGatewayPlugins({
          baseMethods,
          cfg: gatewayPluginConfigAtStart,
          coreGatewayHandlers,
          log,
          logDiagnostics: false,
          pluginIds: startupPluginIds,
          workspaceDir: defaultWorkspaceDir,
        }));
        runtimeState.gatewayMethods = listActiveGatewayMethods(baseGatewayMethods);
      }
    }

    attachGatewayWsHandlers({
      broadcast,
      browserRateLimiter: browserAuthRateLimiter,
      canvasHostEnabled: Boolean(canvasHost),
      canvasHostServerPort,
      clients,
      context: gatewayRequestContext,
      events: GATEWAY_EVENTS,
      extraHandlers: { ...pluginRegistry.gatewayHandlers, ...extraHandlers },
      gatewayHost: bindHost ?? undefined,
      gatewayMethods: runtimeState.gatewayMethods,
      getRequiredSharedGatewaySessionGeneration: () =>
        getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
      getResolvedAuth,
      logGateway: log,
      logHealth,
      logWsControl,
      port,
      preauthConnectionBudget,
      rateLimiter: authRateLimiter,
      resolvedAuth,
      wss,
    });
    ({
      stopGatewayUpdateCheck: runtimeState.stopGatewayUpdateCheck,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      pluginServices: runtimeState.pluginServices,
    } = await startGatewayPostAttachRuntime({
      bindHost,
      bindHosts: httpBindHosts,
      broadcast,
      cfgAtStart,
      controlUiBasePath,
      defaultWorkspaceDir,
      deps,
      gatewayPluginConfigAtStart,
      isNixMode,
      log,
      logChannels,
      logHooks,
      logTailscale,
      minimalTestGateway,
      pluginCount: pluginRegistry.plugins.length,
      pluginRegistry,
      port,
      resetOnExit: tailscaleConfig.resetOnExit ?? false,
      startChannels,
      startupStartedAt: opts.startupStartedAt,
      tailscaleMode,
      tlsEnabled: gatewayTls.enabled,
      unavailableGatewayMethods,
    }));

    runtimeState.configReloader = startManagedGatewayConfigReloader({
      activateRuntimeSecrets,
      broadcast,
      channelManager,
      clients,
      deps,
      getState: () => ({
        channelHealthMonitor: runtimeState.channelHealthMonitor,
        cronState: runtimeState.cronState,
        heartbeatRunner: runtimeState.heartbeatRunner,
        hookClientIpConfig: runtimeState.hookClientIpConfig,
        hooksConfig: runtimeState.hooksConfig,
      }),
      initialConfig: cfgAtStart,
      initialInternalWriteHash: startupInternalWriteHash,
      logChannels,
      logCron,
      logHooks,
      logReload,
      minimalTestGateway,
      readSnapshot: readConfigFileSnapshot,
      resolveSharedGatewaySessionGenerationForConfig,
      setState: (nextState) => {
        runtimeState.hooksConfig = nextState.hooksConfig;
        runtimeState.hookClientIpConfig = nextState.hookClientIpConfig;
        runtimeState.heartbeatRunner = nextState.heartbeatRunner;
        runtimeState.cronState = nextState.cronState;
        deps.cron = runtimeState.cronState.cron;
        runtimeState.channelHealthMonitor = nextState.channelHealthMonitor;
      },
      sharedGatewaySessionGenerationState,
      startChannel,
      stopChannel,
      subscribeToWrites: registerConfigWriteListener,
      watchPath: configSnapshot.path,
    });
  } catch (error) {
    await closeOnStartupFailure();
    throw error;
  }

  const close = createGatewayCloseHandler({
    agentUnsub: runtimeState.agentUnsub,
    bonjourStop: runtimeState.bonjourStop,
    broadcast,
    canvasHost,
    canvasHostServer,
    chatRunState,
    clients,
    configReloader: runtimeState.configReloader,
    cron: runtimeState.cronState.cron,
    dedupeCleanup: runtimeState.dedupeCleanup,
    healthInterval: runtimeState.healthInterval,
    heartbeatRunner: runtimeState.heartbeatRunner,
    heartbeatUnsub: runtimeState.heartbeatUnsub,
    httpServer,
    httpServers,
    lifecycleUnsub: runtimeState.lifecycleUnsub,
    mediaCleanup: runtimeState.mediaCleanup,
    nodePresenceTimers,
    pluginServices: runtimeState.pluginServices,
    releasePluginRouteRegistry,
    stopChannel,
    stopTaskRegistryMaintenance,
    tailscaleCleanup: runtimeState.tailscaleCleanup,
    tickInterval: runtimeState.tickInterval,
    transcriptUnsub: runtimeState.transcriptUnsub,
    updateCheckStop: runtimeState.stopGatewayUpdateCheck,
    wss,
  });

  return {
    close: async (opts) => {
      // Run gateway_stop plugin hook before shutdown
      await runGlobalGatewayStopSafely({
        ctx: { port },
        event: { reason: opts?.reason ?? "gateway stopping" },
        onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
      });
      await runClosePrelude();
      await close(opts);
    },
  };
}
