export const PROCESS_TEST_TIMEOUT_MS = {
  extraLong: 15_000,
  long: 10_000,
  medium: 5000,
  short: 100,
  standard: 3000,
  tiny: 25,
} as const;

export const PROCESS_TEST_SCRIPT_DELAY_MS = {
  silentProcess: 120,
  streamingDuration: 9000,
  streamingInterval: 1800,
} as const;

export const PROCESS_TEST_NO_OUTPUT_TIMEOUT_MS = {
  exec: 120,
  streamingAllowance: 6000,
  supervisor: 100,
} as const;
