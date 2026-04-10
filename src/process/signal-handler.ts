/**
 * Improved signal handling with graceful shutdown coordination.
 * Handles SIGTERM, SIGINT, and other signals with proper cleanup.
 */

interface SignalHandlerOptions {
  timeout?: number;
  onShutdown: (signal: NodeJS.Signals) => Promise<void> | void;
}

export class SignalHandler {
  private handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();
  private shutdownInProgress = false;
  private timeout: number;
  private onShutdown: (signal: NodeJS.Signals) => Promise<void> | void;

  constructor(options: SignalHandlerOptions) {
    this.timeout = options.timeout ?? 10000;
    this.onShutdown = options.onShutdown;
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
        return;
      }
      this.shutdownInProgress = true;

      try {
        await Promise.race([
          this.onShutdown(signal),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              console.error(`Shutdown timed out after ${this.timeout}ms, forcing exit`);
              resolve();
            }, this.timeout),
          ),
        ]);
      } catch (error) {
        console.error("Error during shutdown:", error);
      } finally {
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
