import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";

export interface GatewayRpcOpts {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
}

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  requireRpc: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export interface DaemonInstallOptions {
  port?: string | number;
  runtime?: string;
  token?: string;
  force?: boolean;
  json?: boolean;
}

export interface DaemonLifecycleOptions {
  json?: boolean;
}
