export const loggingState = {
  cachedConsoleSettings: null as unknown,
  cachedLogger: null as unknown,
  cachedSettings: null as unknown,
  consolePatched: false,
  consoleSubsystemFilter: null as string[] | null,
  consoleTimestampPrefix: false,
  forceConsoleToStderr: false,
  invalidEnvLogLevelValue: null as string | null,
  overrideSettings: null as unknown,
  rawConsole: null as {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null,
  resolvingConsoleSettings: false,
  streamErrorHandlersInstalled: false,
};
