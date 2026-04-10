import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resolveActivePluginHttpRouteRegistry,
} from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import { isLoopbackHost, resolveGatewayListenHosts } from "./net.js";
import {
  type GatewayBroadcastFn,
  type GatewayBroadcastToConnIdsFn,
  createGatewayBroadcaster,
} from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import {
  type HookClientIpConfig,
  attachGatewayUpgradeHandler,
  createGatewayHttpServer,
} from "./server-http.js";
import type { DedupeEntry } from "./server-shared.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import {
  type PluginRoutePathContext,
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "./server/plugins-http.js";
import {
  type PreauthConnectionBudget,
  createPreauthConnectionBudget,
} from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  getHookClientIpConfig: () => HookClientIpConfig;
  pluginRegistry: PluginRegistry;
  pinChannelRegistry?: boolean;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
  getReadiness?: ReadinessChecker;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  releasePluginRouteRegistry: () => void;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  preauthConnectionBudget: PreauthConnectionBudget;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  pinActivePluginHttpRouteRegistry(params.pluginRegistry);
  if (params.pinChannelRegistry !== false) {
    pinActivePluginChannelRegistry(params.pluginRegistry);
  } else {
    releasePinnedPluginChannelRegistry();
  }
  try {
    let canvasHost: CanvasHostHandler | null = null;
    if (params.canvasHostEnabled) {
      try {
        const handler = await createCanvasHostHandler({
          allowInTests: params.allowCanvasHostInTests,
          basePath: CANVAS_HOST_PATH,
          liveReload: params.cfg.canvasHost?.liveReload,
          rootDir: params.cfg.canvasHost?.root,
          runtime: params.canvasRuntime,
        });
        if (handler.rootDir) {
          canvasHost = handler;
          params.logCanvas.info(
            `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
          );
        }
      } catch (error) {
        params.logCanvas.warn(`canvas host failed to start: ${String(error)}`);
      }
    }

    const clients = new Set<GatewayWsClient>();
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    const handleHooksRequest = createGatewayHooksRequestHandler({
      bindHost: params.bindHost,
      deps: params.deps,
      getClientIpConfig: params.getHookClientIpConfig,
      getHooksConfig: params.hooksConfig,
      logHooks: params.logHooks,
      port: params.port,
    });

    const handlePluginRequest = createGatewayPluginRequestHandler({
      log: params.logPlugins,
      registry: params.pluginRegistry,
    });
    const shouldEnforcePluginGatewayAuth = (pathContext: PluginRoutePathContext): boolean => shouldEnforceGatewayAuthForPluginPath(
        resolveActivePluginHttpRouteRegistry(params.pluginRegistry),
        pathContext,
      );

    const bindHosts = await resolveGatewayListenHosts(params.bindHost);
    if (!isLoopbackHost(params.bindHost)) {
      params.log.warn(
        "⚠️  Gateway is binding to a non-loopback address. " +
          "Ensure authentication is configured before exposing to public networks.",
      );
    }
    if (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
      params.log.warn(
        "⚠️  gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true is enabled. " +
          "Host-header origin fallback weakens origin checks and should only be used as break-glass.",
      );
    }
    const httpServers: HttpServer[] = [];
    const httpBindHosts: string[] = [];
    for (const host of bindHosts) {
      const httpServer = createGatewayHttpServer({
        canvasHost,
        clients,
        controlUiBasePath: params.controlUiBasePath,
        controlUiEnabled: params.controlUiEnabled,
        controlUiRoot: params.controlUiRoot,
        getReadiness: params.getReadiness,
        handleHooksRequest,
        handlePluginRequest,
        openAiChatCompletionsConfig: params.openAiChatCompletionsConfig,
        openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
        openResponsesConfig: params.openResponsesConfig,
        openResponsesEnabled: params.openResponsesEnabled,
        rateLimiter: params.rateLimiter,
        resolvedAuth: params.resolvedAuth,
        shouldEnforcePluginGatewayAuth,
        strictTransportSecurityHeader: params.strictTransportSecurityHeader,
        tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
      });
      try {
        await listenGatewayHttpServer({
          bindHost: host,
          httpServer,
          port: params.port,
        });
        httpServers.push(httpServer);
        httpBindHosts.push(host);
      } catch (error) {
        if (host === bindHosts[0]) {
          throw error;
        }
        params.log.warn(
          `gateway: failed to bind loopback alias ${host}:${params.port} (${String(error)})`,
        );
      }
    }
    const httpServer = httpServers[0];
    if (!httpServer) {
      throw new Error("Gateway HTTP server failed to start");
    }

    const wss = new WebSocketServer({
      maxPayload: MAX_PREAUTH_PAYLOAD_BYTES,
      noServer: true,
    });
    const preauthConnectionBudget = createPreauthConnectionBudget();
    for (const server of httpServers) {
      attachGatewayUpgradeHandler({
        canvasHost,
        clients,
        httpServer: server,
        preauthConnectionBudget,
        rateLimiter: params.rateLimiter,
        resolvedAuth: params.resolvedAuth,
        wss,
      });
    }

    const agentRunSeq = new Map<string, number>();
    const dedupe = new Map<string, DedupeEntry>();
    const chatRunState = createChatRunState();
    const chatRunRegistry = chatRunState.registry;
    const chatRunBuffers = chatRunState.buffers;
    const chatDeltaSentAt = chatRunState.deltaSentAt;
    const chatDeltaLastBroadcastLen = chatRunState.deltaLastBroadcastLen;
    const addChatRun = chatRunRegistry.add;
    const removeChatRun = chatRunRegistry.remove;
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    const toolEventRecipients = createToolEventRecipientRegistry();

    return {
      addChatRun,
      agentRunSeq,
      broadcast,
      broadcastToConnIds,
      canvasHost,
      chatAbortControllers,
      chatDeltaLastBroadcastLen,
      chatDeltaSentAt,
      chatRunBuffers,
      chatRunState,
      clients,
      dedupe,
      httpBindHosts,
      httpServer,
      httpServers,
      preauthConnectionBudget,
      releasePluginRouteRegistry: () => {
        // Releases both pinned HTTP-route and channel registries set at startup.
        releasePinnedPluginHttpRouteRegistry(params.pluginRegistry);
        // Release unconditionally (no registry arg): the channel pin may have
        // Been re-pinned to a deferred-reload registry that differs from the
        // Original params.pluginRegistry, so an identity-guarded release would
        // Be a no-op and leak the pin across in-process restarts.
        releasePinnedPluginChannelRegistry();
      },
      removeChatRun,
      toolEventRecipients,
      wss,
    };
  } catch (error) {
    releasePinnedPluginHttpRouteRegistry(params.pluginRegistry);
    releasePinnedPluginChannelRegistry();
    throw error;
  }
}
