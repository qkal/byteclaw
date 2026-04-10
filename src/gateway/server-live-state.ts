import type { PluginServicesHandle } from "../plugins/services.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { GatewayCronState } from "./server-cron.js";
import type { HookClientIpConfig } from "./server-http.js";
import {
  type GatewayServerMutableState,
  createGatewayServerMutableState,
} from "./server-runtime-handles.js";

export type GatewayServerLiveState = GatewayServerMutableState & {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  pluginServices: PluginServicesHandle | null;
  gatewayMethods: string[];
};

export function createGatewayServerLiveState(params: {
  hooksConfig: HooksConfigResolved | null;
  hookClientIpConfig: HookClientIpConfig;
  cronState: GatewayCronState;
  gatewayMethods: string[];
}): GatewayServerLiveState {
  return {
    ...createGatewayServerMutableState(),
    cronState: params.cronState,
    gatewayMethods: params.gatewayMethods,
    hookClientIpConfig: params.hookClientIpConfig,
    hooksConfig: params.hooksConfig,
    pluginServices: null,
  };
}
