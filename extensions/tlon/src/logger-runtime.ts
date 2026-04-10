import { format } from "node:util";

interface RuntimeLoggerLike {
  info: (message: string) => void;
  error: (message: string) => void;
}

interface LoggerBackedRuntime {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  writeStdout: (value: string) => void;
  writeJson: (value: unknown, space?: number) => void;
  exit: (code: number) => never;
}

export function createLoggerBackedRuntime(params: {
  logger: RuntimeLoggerLike;
  exitError?: (code: number) => Error;
}): LoggerBackedRuntime {
  return {
    error: (...args) => {
      params.logger.error(format(...args));
    },
    exit: (code: number): never => {
      throw params.exitError?.(code) ?? new Error(`exit ${code}`);
    },
    log: (...args) => {
      params.logger.info(format(...args));
    },
    writeJson: (value, space = 2) => {
      params.logger.info(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
    writeStdout: (value) => {
      params.logger.info(value);
    },
  };
}
