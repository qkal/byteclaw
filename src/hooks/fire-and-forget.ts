import { logVerbose } from "../globals.js";

export function fireAndForgetHook(
  task: Promise<unknown>,
  label: string,
  logger: (message: string) => void = logVerbose,
): void {
  void task.catch((error) => {
    logger(`${label}: ${String(error)}`);
  });
}
