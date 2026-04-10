/**
 * Centralized timeout handling with proper cleanup and error handling.
 * Production-grade implementation with cancellation support and resource cleanup.
 */

export interface TimeoutOptions {
  timeoutMs: number;
  onTimeout?: () => void;
  errorMessage?: string;
}

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class TimeoutController {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private timer: Promise<never> | null = null;
  private aborted = false;

  constructor(private options: TimeoutOptions) {}

  /**
   * Start the timeout timer.
   */
  start(): Promise<never> {
    if (this.aborted) {
      return Promise.reject(new TimeoutError('Timeout already aborted', this.options.timeoutMs));
    }

    this.timer = new Promise<never>((_, reject) => {
      this.timeoutId = setTimeout(() => {
        this.aborted = true;
        const message = this.options.errorMessage ?? `Operation timed out after ${this.options.timeoutMs}ms`;
        this.options.onTimeout?.();
        reject(new TimeoutError(message, this.options.timeoutMs));
      }, this.options.timeoutMs);
    });

    return this.timer;
  }

  /**
   * Clear the timeout.
   */
  clear(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.aborted = true;
    this.timer = null;
  }

  /**
   * Check if timeout is active.
   */
  isActive(): boolean {
    return !this.aborted && this.timeoutId !== null;
  }

  /**
   * Get the timeout promise.
   */
  get timerPromise(): Promise<never> | null {
    return this.timer;
  }
}

/**
 * Execute a function with a timeout.
 * Automatically cleans up resources on timeout.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => T | Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  const controller = new AbortController();
  const timeoutController = new TimeoutController(options);

  try {
    const result = await Promise.race([
      fn(controller.signal),
      timeoutController.start(),
    ]);
    return result as T;
  } finally {
    timeoutController.clear();
    controller.abort();
  }
}

/**
 * Execute multiple operations with individual timeouts.
 */
export async function withTimeouts<T>(
  operations: Array<{ fn: () => T | Promise<T>; timeoutMs: number }>,
  options?: { failFast?: boolean },
): Promise<Array<{ success: boolean; result?: T; error?: Error }>> {
  const results = await Promise.allSettled(
    operations.map(async ({ fn, timeoutMs }) => {
      return withTimeout(() => fn(), { timeoutMs });
    }),
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return { success: true, result: result.value };
    }
    if (options?.failFast) {
      throw result.reason;
    }
    return { success: false, error: result.reason as Error };
  });
}

/**
 * Create a debounced function with timeout.
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (this: unknown, ...args: Parameters<T>) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn.apply(this, args);
      timeoutId = null;
    }, delayMs);
  };
}

/**
 * Create a throttled function with timeout.
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  intervalMs: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (this: unknown, ...args: Parameters<T>) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall >= intervalMs) {
      fn.apply(this, args);
      lastCall = now;
    } else if (timeoutId === null) {
      timeoutId = setTimeout(() => {
        fn.apply(this, args);
        lastCall = Date.now();
        timeoutId = null;
      }, intervalMs - timeSinceLastCall);
    }
  };
}
