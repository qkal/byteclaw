/**
 * Production-grade signal handling with graceful shutdown coordination.
 * Handles SIGTERM, SIGINT, and other signals with proper cleanup, logging, and error handling.
 */

interface SignalHandlerOptions {
  timeout?: number;
  onShutdown: (signal: NodeJS.Signals) => Promise<void> | void;
  onSignalReceived?: (signal: NodeJS.Signals) => void;
  logger?: {
    info: (message: string) => void;
    error: (message: string, error?: unknown) => void;
  };
}

export interface ShutdownStats {
  signal: NodeJS.Signals;
  startTime: number;
  endTime: number;
  durationMs: number;
  timedOut: boolean;
  error?: Error;
}

export class SignalHandler {
  private handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();
  private shutdownInProgress = false;
  private timeout: number;
  private onShutdown: (signal: NodeJS.Signals) => Promise<void> | void;
  private onSignalReceived?: (signal: NodeJS.Signals) => void;
  private logger: {
    info: (message: string) => void;
    error: (message: string, error?: unknown) => void;
  };
  private shutdownStats: ShutdownStats | null = null;

  constructor(options: SignalHandlerOptions) {
    this.timeout = options.timeout ?? 10000;
    this.onShutdown = options.onShutdown;
    this.onSignalReceived = options.onSignalReceived;
    this.logger = options.logger ?? {
      info: console.log,
      error: console.error,
    };
  }

  /**
   * Register signal handlers for graceful shutdown.
   */
  register(signals: NodeJS.Signals[]): void {
    for (const signal of signals) {
      const listener = this.createListener(signal);
      this.handlers.set(signal, listener);
      process.on(signal, listener);
    }
  }

  /**
   * Unregister signal handlers.
   */
  unregister(): void {
    for (const [signal, listener] of this.handlers) {
      process.off(signal, listener);
    }
    this.handlers.clear();
  }

  private createListener(signal: NodeJS.Signals): NodeJS.SignalsListener {
    return async () => {
      if (this.shutdownInProgress) {
        this.logger.info(`Shutdown already in progress, ignoring ${signal}`);
        return;
      }
      this.shutdownInProgress = true;

      this.onSignalReceived?.(signal);
      this.logger.info(`Received ${signal}, starting graceful shutdown...`);

      const startTime = Date.now();
      let timedOut = false;
      let error: Error | undefined;

      try {
        await Promise.race([
          this.onShutdown(signal),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              this.logger.error(`Shutdown timed out after ${this.timeout}ms, forcing exit`);
              timedOut = true;
              resolve();
            }, this.timeout),
          ),
        ]);
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        this.logger.error("Error during shutdown:", error);
      } finally {
        const endTime = Date.now();
        this.shutdownStats = {
          signal,
          startTime,
          endTime,
          durationMs: endTime - startTime,
          timedOut,
          error,
        };

        this.logger.info(`Shutdown completed in ${this.shutdownStats.durationMs}ms`);
        this.unregister();
        process.exit(signal === "SIGTERM" ? 0 : 1);
      }
    };
  }

  /**
   * Check if shutdown is in progress.
   */
  isShuttingDown(): boolean {
    return this.shutdownInProgress;
  }

  /**
   * Get shutdown statistics from the last shutdown.
   */
  getShutdownStats(): ShutdownStats | null {
    return this.shutdownStats;
  }
}

/**
 * Create a default signal handler with common signals.
 */
export function createSignalHandler(
  onShutdown: (signal: NodeJS.Signals) => Promise<void> | void,
  options?: Omit<SignalHandlerOptions, "onShutdown">,
): SignalHandler {
  const handler = new SignalHandler({ ...options, onShutdown });
  handler.register(["SIGTERM", "SIGINT"]);
  return handler;
}
