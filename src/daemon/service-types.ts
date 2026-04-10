import type { GatewayServiceRuntime } from "./service-runtime.js";

export type GatewayServiceEnv = Record<string, string | undefined>;

export interface GatewayServiceInstallArgs {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  description?: string;
}

export type GatewayServiceStageArgs = GatewayServiceInstallArgs;

export interface GatewayServiceManageArgs {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
}

export interface GatewayServiceControlArgs {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
}

export type GatewayServiceRestartResult = { outcome: "completed" } | { outcome: "scheduled" };

export interface GatewayServiceEnvArgs {
  env?: GatewayServiceEnv;
}

export interface GatewayServiceCommandConfig {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, "inline" | "file">;
  sourcePath?: string;
}

export interface GatewayServiceState {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig | null;
  runtime?: GatewayServiceRuntime;
}

export type GatewayServiceStartResult =
  | { outcome: "started"; state: GatewayServiceState }
  | { outcome: "scheduled"; state: GatewayServiceState }
  | { outcome: "missing-install"; state: GatewayServiceState };

export interface GatewayServiceRenderArgs {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
}
