export interface ConsoleSnapshot {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.trace;
}

export function captureConsoleSnapshot(): ConsoleSnapshot {
  return {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    trace: console.trace,
    warn: console.warn,
  };
}

export function restoreConsoleSnapshot(snapshot: ConsoleSnapshot): void {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
}
