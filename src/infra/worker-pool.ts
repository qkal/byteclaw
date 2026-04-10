/**
 * Worker Thread Pool
 * Provides a pool of worker threads for CPU-intensive tasks
 */

import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

interface WorkerTask<TInput, TOutput> {
  id: string;
  input: TInput;
  resolve: (output: TOutput) => void;
  reject: (error: Error) => void;
}

interface WorkerPoolOptions {
  maxWorkers?: number;
  taskTimeout?: number;
}

class WorkerPool<TInput, TOutput> {
  private workers: Worker[] = [];
  private taskQueue: Map<string, WorkerTask<TInput, TOutput>> = new Map();
  private busyWorkers = new Set<Worker>();
  private options: Required<WorkerPoolOptions>;

  constructor(
    private workerScript: string,
    options: WorkerPoolOptions = {},
  ) {
    this.options = {
      maxWorkers: options.maxWorkers ?? Math.max(1, (os?.cpus()?.length ?? 4) - 1),
      taskTimeout: options.taskTimeout ?? 30000, // 30 seconds
    };
  }

  /**
   * Initialize the worker pool
   */
  async initialize(): Promise<void> {
    for (let i = 0; i < this.options.maxWorkers; i++) {
      const worker = new Worker(this.workerScript);
      worker.on("message", (result) => this.handleWorkerMessage(worker, result));
      worker.on("error", (error) => this.handleWorkerError(worker, error));
      worker.on("exit", (code) => this.handleWorkerExit(worker, code));
      this.workers.push(worker);
    }
  }

  /**
   * Execute a task on an available worker
   */
  async execute(input: TInput): Promise<TOutput> {
    return new Promise((resolve, reject) => {
      const taskId = `${Date.now()}-${Math.random()}`;
      const worker = this.getAvailableWorker();

      if (!worker) {
        // Queue task if no workers available
        this.taskQueue.set(taskId, { id: taskId, input, resolve, reject });
        return;
      }

      this.busyWorkers.add(worker);
      this.taskQueue.set(taskId, { id: taskId, input, resolve, reject });

      worker.postMessage({ taskId, input });

      // Set timeout
      const timeout = setTimeout(() => {
        this.taskQueue.delete(taskId);
        this.busyWorkers.delete(worker);
        reject(new Error(`Task ${taskId} timed out`));
      }, this.options.taskTimeout);

      // Store timeout for cleanup
      (this.taskQueue.get(taskId) as any).timeout = timeout;
    });
  }

  /**
   * Get an available worker
   */
  private getAvailableWorker(): Worker | undefined {
    return this.workers.find((w) => !this.busyWorkers.has(w));
  }

  /**
   * Handle message from worker
   */
  private handleWorkerMessage(worker: Worker, result: { taskId: string; output: TOutput }): void {
    const task = this.taskQueue.get(result.taskId);
    if (!task) return;

    clearTimeout((task as any).timeout);
    this.taskQueue.delete(result.taskId);
    this.busyWorkers.delete(worker);
    task.resolve(result.output);
  }

  /**
   * Handle worker error
   */
  private handleWorkerError(worker: Worker, error: Error): void {
    this.busyWorkers.delete(worker);
    // Reject all pending tasks for this worker
    for (const [taskId, task] of this.taskQueue) {
      if (this.busyWorkers.has(worker)) {
        clearTimeout((task as any).timeout);
        this.taskQueue.delete(taskId);
        task.reject(error);
      }
    }
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(worker: Worker, code: number): void {
    this.busyWorkers.delete(worker);
    const index = this.workers.indexOf(worker);
    if (index > -1) {
      this.workers.splice(index, 1);
    }

    // Restart worker if it crashed
    if (code !== 0 && this.workers.length < this.options.maxWorkers) {
      const newWorker = new Worker(this.workerScript);
      newWorker.on("message", (result) => this.handleWorkerMessage(newWorker, result));
      newWorker.on("error", (error) => this.handleWorkerError(newWorker, error));
      newWorker.on("exit", (exitCode) => this.handleWorkerExit(newWorker, exitCode));
      this.workers.push(newWorker);
    }
  }

  /**
   * Shutdown the worker pool
   */
  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
    this.busyWorkers.clear();
    this.taskQueue.clear();
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalWorkers: this.workers.length,
      busyWorkers: this.busyWorkers.size,
      queuedTasks: this.taskQueue.size,
      maxWorkers: this.options.maxWorkers,
    };
  }
}

// Worker-side code
if (!isMainThread && parentPort) {
  parentPort.on("message", async (data: { taskId: string; input: unknown }) => {
    try {
      // Import and execute the worker function
      const { processTask } = await import(workerData as string);
      const output = await processTask(data.input);
      parentPort!.postMessage({ taskId: data.taskId, output });
    } catch (error) {
      parentPort!.postMessage({
        taskId: data.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Create a worker pool for a given worker script
 */
export function createWorkerPool<TInput, TOutput>(
  workerScript: string,
  options?: WorkerPoolOptions,
): WorkerPool<TInput, TOutput> {
  return new WorkerPool<TInput, TOutput>(workerScript, options);
}
