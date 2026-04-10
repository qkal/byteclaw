import type { PluginLogger } from "./types.js";

interface LoggerLike {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

export function createPluginLoaderLogger(logger: LoggerLike): PluginLogger {
  return {
    debug: (msg) => logger.debug?.(msg),
    error: (msg) => logger.error(msg),
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
  };
}
