import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const { results } = await runTasksWithConcurrency({
    limit,
    onTaskError(err) {
      if (shouldLogVerbose()) {
        logVerbose(`Media understanding task failed: ${String(err)}`);
      }
    },
    tasks,
  });
  return results;
}
