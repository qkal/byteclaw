import { RateLimitError } from "@buape/carbon";
import {
  type RetryConfig,
  type RetryRunner,
  createRateLimitRetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  jitter: 0.1,
  maxDelayMs: 30_000,
  minDelayMs: 500,
} satisfies RetryConfig;

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  return createRateLimitRetryRunner({
    ...params,
    defaults: DISCORD_RETRY_DEFAULTS,
    logLabel: "discord",
    retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
    shouldRetry: (err) => err instanceof RateLimitError,
  });
}
