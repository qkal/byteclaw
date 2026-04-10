import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import {
  type GatewayWsSharedHandlerParams,
  attachGatewayWsConnectionHandler,
} from "./server/ws-connection.js";

type GatewayWsRuntimeParams = GatewayWsSharedHandlerParams & {
  logGateway: ReturnType<typeof createSubsystemLogger>;
  logHealth: ReturnType<typeof createSubsystemLogger>;
  logWsControl: ReturnType<typeof createSubsystemLogger>;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  context: GatewayRequestContext;
};

export function attachGatewayWsHandlers(params: GatewayWsRuntimeParams) {
  attachGatewayWsConnectionHandler({
    broadcast: params.broadcast,
    browserRateLimiter: params.browserRateLimiter,
    buildRequestContext: () => params.context,
    canvasHostEnabled: params.canvasHostEnabled,
    canvasHostServerPort: params.canvasHostServerPort,
    clients: params.clients,
    events: params.events,
    extraHandlers: params.extraHandlers,
    gatewayHost: params.gatewayHost,
    gatewayMethods: params.gatewayMethods,
    getRequiredSharedGatewaySessionGeneration: params.getRequiredSharedGatewaySessionGeneration,
    getResolvedAuth: params.getResolvedAuth,
    logGateway: params.logGateway,
    logHealth: params.logHealth,
    logWsControl: params.logWsControl,
    port: params.port,
    preauthConnectionBudget: params.preauthConnectionBudget,
    rateLimiter: params.rateLimiter,
    resolvedAuth: params.resolvedAuth,
    wss: params.wss,
  });
}
