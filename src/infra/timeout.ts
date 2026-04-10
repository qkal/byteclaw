/**
 * Comprehensive timeout utilities
 * Ensures all async operations have appropriate timeouts
 */

/**
 * Create a timeout promise that rejects after specified duration
 */
export function createTimeout(
  ms: number,
  message = `Operation timed out after ${ms}ms`,
): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    // Don't keep the timer from preventing process exit
    if (timer.unref) {
      timer.unref();
    }
  });
}

/**
 * Wrap a promise with a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
): Promise<T> {
  return Promise.race([promise, createTimeout(ms, message)]);
}

/**
 * Default timeout configurations (in milliseconds)
 */
export const DEFAULT_TIMEOUTS = {
  // HTTP requests
  httpRequest: 30_000, // 30 seconds
  httpRequestShort: 5000, // 5 seconds for quick requests
  httpRequestLong: 120_000, // 2 minutes for long-running requests

  // File operations
  fileRead: 5000, // 5 seconds
  fileWrite: 10_000, // 10 seconds
  fileDelete: 5000, // 5 seconds

  // Database operations
  dbQuery: 10_000, // 10 seconds
  dbTransaction: 30_000, // 30 seconds

  // Process operations
  processSpawn: 5000, // 5 seconds to spawn
  processExecution: 60_000, // 1 minute total execution
  processExecutionLong: 300_000, // 5 minutes for long-running processes

  // Network operations
  dnsLookup: 5000, // 5 seconds
  tcpConnect: 10_000, // 10 seconds
  tlsHandshake: 10_000, // 10 seconds

  // AI/LLM operations
  llmInference: 120_000, // 2 minutes
  llmInferenceLong: 300_000, // 5 minutes for complex tasks

  // Plugin operations
  pluginLoad: 10_000, // 10 seconds
  pluginInit: 30_000, // 30 seconds

  // Gateway operations
  gatewayStartup: 30_000, // 30 seconds
  gatewayHealthCheck: 5000, // 5 seconds

  // Configuration operations
  configLoad: 5000, // 5 seconds
  configSave: 5000, // 5 seconds

  // Authentication operations
  authValidate: 5000, // 5 seconds
  authRefresh: 10_000, // 10 seconds
} as const;

/**
 * Timeout error class
 */
export class TimeoutError extends Error {
  constructor(
    public duration: number,
    message?: string,
  ) {
    super(message || `Operation timed out after ${duration}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Create a timeout error with standard format
 */
export function createTimeoutError(duration: number, operation?: string): TimeoutError {
  const message = operation
    ? `Operation "${operation}" timed out after ${duration}ms`
    : `Operation timed out after ${duration}ms`;
  return new TimeoutError(duration, message);
}

/**
 * Execute function with retry and timeout
 */
export async function withRetryAndTimeout<T>(
  fn: () => Promise<T>,
  options: {
    timeout: number;
    maxRetries?: number;
    retryDelay?: number;
    operation?: string;
  },
): Promise<T> {
  const { timeout, maxRetries = 3, retryDelay = 1000, operation } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn(), timeout);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry timeout errors
      if (lastError instanceof TimeoutError) {
        throw lastError;
      }

      // Retry on other errors
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error("Operation failed after retries");
}

/**
 * Create a timeout-aware fetch wrapper
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeout?: number },
): Promise<Response> {
  const timeout = init?.timeout ?? DEFAULT_TIMEOUTS.httpRequest;
  const { timeout: _, ...fetchInit } = init || {};

  return withTimeout(fetch(input, fetchInit), timeout);
}
