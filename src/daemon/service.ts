import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stageLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stageScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStageArgs,
  GatewayServiceStartResult,
  GatewayServiceState,
} from "./service-types.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
export type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";

function ignoreServiceWriteResult<TArgs extends GatewayServiceInstallArgs>(
  write: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<void> {
  return async (args: TArgs) => {
    await write(args);
  };
}

export interface GatewayService {
  label: string;
  loadedText: string;
  notLoadedText: string;
  stage: (args: GatewayServiceStageArgs) => Promise<void>;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
}

function mergeGatewayServiceEnv(
  baseEnv: GatewayServiceEnv,
  command: GatewayServiceCommandConfig | null,
): GatewayServiceEnv {
  if (!command?.environment) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ...command.environment,
  };
}

export async function readGatewayServiceState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  const command = await service.readCommand(baseEnv).catch(() => null);
  const env = mergeGatewayServiceEnv(baseEnv, command);
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env }).catch(() => false),
    service.readRuntime(env).catch(() => undefined),
  ]);
  return {
    command,
    env,
    installed: command !== null,
    loaded,
    running: runtime?.status === "running",
    runtime,
  };
}

export async function startGatewayService(
  service: GatewayService,
  args: GatewayServiceControlArgs,
): Promise<GatewayServiceStartResult> {
  const state = await readGatewayServiceState(service, { env: args.env });
  if (!state.loaded && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  try {
    const restartResult = await service.restart({ ...args, env: state.env });
    const nextState = await readGatewayServiceState(service, { env: state.env });
    return {
      outcome: restartResult.outcome === "scheduled" ? "scheduled" : "started",
      state: nextState,
    };
  } catch (error) {
    const nextState = await readGatewayServiceState(service, { env: state.env });
    if (!nextState.installed) {
      return {
        outcome: "missing-install",
        state: nextState,
      };
    }
    throw error;
  }
}

export function describeGatewayServiceRestart(
  serviceNoun: string,
  result: GatewayServiceRestartResult,
): {
  scheduled: boolean;
  daemonActionResult: "restarted" | "scheduled";
  message: string;
  progressMessage: string;
} {
  if (result.outcome === "scheduled") {
    return {
      daemonActionResult: "scheduled",
      message: `restart scheduled, ${normalizeLowercaseStringOrEmpty(serviceNoun)} will restart momentarily`,
      progressMessage: `${serviceNoun} service restart scheduled.`,
      scheduled: true,
    };
  }
  return {
    daemonActionResult: "restarted",
    message: `${serviceNoun} service restarted.`,
    progressMessage: `${serviceNoun} service restarted.`,
    scheduled: false,
  };
}

type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    install: ignoreServiceWriteResult(installLaunchAgent),
    isLoaded: isLaunchAgentLoaded,
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
    restart: restartLaunchAgent,
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    stop: stopLaunchAgent,
    uninstall: uninstallLaunchAgent,
  },
  linux: {
    install: ignoreServiceWriteResult(installSystemdService),
    isLoaded: isSystemdServiceEnabled,
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    readCommand: readSystemdServiceExecStart,
    readRuntime: readSystemdServiceRuntime,
    restart: restartSystemdService,
    stage: ignoreServiceWriteResult(stageSystemdService),
    stop: stopSystemdService,
    uninstall: uninstallSystemdService,
  },
  win32: {
    install: ignoreServiceWriteResult(installScheduledTask),
    isLoaded: isScheduledTaskInstalled,
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
    restart: restartScheduledTask,
    stage: ignoreServiceWriteResult(stageScheduledTask),
    stop: stopScheduledTask,
    uninstall: uninstallScheduledTask,
  },
};

function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is SupportedGatewayServicePlatform {
  return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}

export function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return GATEWAY_SERVICE_REGISTRY[process.platform];
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
