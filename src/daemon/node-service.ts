import {
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

function withNodeServiceEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    OPENCLAW_LOG_PREFIX: "node",
    OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
    OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
    OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
  };
}

function withNodeInstallEnv(args: GatewayServiceInstallArgs): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withNodeServiceEnv(args.env),
    environment: {
      ...args.environment,
      OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      OPENCLAW_LOG_PREFIX: "node",
      OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
      OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
      OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
      OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
      OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    },
  };
}

export function resolveNodeService(): GatewayService {
  const base = resolveGatewayService();
  return {
    ...base,
    install: async (args) => base.install(withNodeInstallEnv(args)),
    isLoaded: async (args) => base.isLoaded({ env: withNodeServiceEnv(args.env ?? {}) }),
    readCommand: (env) => base.readCommand(withNodeServiceEnv(env)),
    readRuntime: (env) => base.readRuntime(withNodeServiceEnv(env)),
    restart: async (args) => base.restart({ ...args, env: withNodeServiceEnv(args.env ?? {}) }),
    stage: async (args) => base.stage(withNodeInstallEnv(args)),
    stop: async (args) => base.stop({ ...args, env: withNodeServiceEnv(args.env ?? {}) }),
    uninstall: async (args) => base.uninstall({ ...args, env: withNodeServiceEnv(args.env) }),
  };
}
