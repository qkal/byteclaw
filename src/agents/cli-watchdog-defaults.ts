export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1000;

export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  maxMs: 600_000,
  minMs: 180_000,
  noOutputTimeoutRatio: 0.8,
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  maxMs: 180_000,
  minMs: 60_000,
  noOutputTimeoutRatio: 0.3,
} as const;
