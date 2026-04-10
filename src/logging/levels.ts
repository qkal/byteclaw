export const ALLOWED_LOG_LEVELS = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export type LogLevel = (typeof ALLOWED_LOG_LEVELS)[number];

export function tryParseLogLevel(level?: string): LogLevel | undefined {
  if (typeof level !== "string") {
    return undefined;
  }
  const candidate = level.trim();
  return ALLOWED_LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : undefined;
}

export function normalizeLogLevel(level?: string, fallback: LogLevel = "info") {
  return tryParseLogLevel(level) ?? fallback;
}

export function levelToMinLevel(level: LogLevel): number {
  // Tslog v4 logLevelId (src/index.ts): silly=0, trace=1, debug=2, info=3, warn=4, error=5, fatal=6
  // Tslog filters: logLevelId < minLevel is dropped, so higher minLevel = more restrictive.
  const map: Record<LogLevel, number> = {
    debug: 2,
    error: 5,
    fatal: 6,
    info: 3,
    silent: Number.POSITIVE_INFINITY,
    trace: 1,
    warn: 4,
  };
  return map[level];
}
