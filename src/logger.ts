import { isVerbose } from "./global-state.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "./runtime.js";
import { theme } from "./terminal/theme.js";

const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;

function splitSubsystem(message: string) {
  const match = message.match(subsystemPrefixRe);
  if (!match) {
    return null;
  }
  const [, subsystem, rest] = match;
  return { rest, subsystem };
}

type LogMethod = "info" | "warn" | "error";
type RuntimeMethod = "log" | "error";

function logWithSubsystem(params: {
  message: string;
  runtime: RuntimeEnv;
  runtimeMethod: RuntimeMethod;
  runtimeFormatter: (value: string) => string;
  loggerMethod: LogMethod;
  subsystemMethod: LogMethod;
}) {
  const parsed = params.runtime === defaultRuntime ? splitSubsystem(params.message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem)[params.subsystemMethod](parsed.rest);
    return;
  }
  params.runtime[params.runtimeMethod](params.runtimeFormatter(params.message));
  getLogger()[params.loggerMethod](params.message);
}

const { info } = theme;
const { warn } = theme;
const { success } = theme;
const danger = theme.error;

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    loggerMethod: "info",
    message,
    runtime,
    runtimeFormatter: info,
    runtimeMethod: "log",
    subsystemMethod: "info",
  });
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    loggerMethod: "warn",
    message,
    runtime,
    runtimeFormatter: warn,
    runtimeMethod: "log",
    subsystemMethod: "warn",
  });
}

export function logSuccess(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    loggerMethod: "info",
    message,
    runtime,
    runtimeFormatter: success,
    runtimeMethod: "log",
    subsystemMethod: "info",
  });
}

export function logError(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    loggerMethod: "error",
    message,
    runtime,
    runtimeFormatter: danger,
    runtimeMethod: "error",
    subsystemMethod: "error",
  });
}

export function logDebug(message: string) {
  // Always emit to file logger (level-filtered); console only when verbose.
  getLogger().debug(message);
  if (isVerbose()) {
    console.log(theme.muted(message));
  }
}
