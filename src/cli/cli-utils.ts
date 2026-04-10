import type { Command } from "commander";
import { formatErrorMessage } from "../infra/errors.js";

export { formatErrorMessage };

export interface ManagerLookupResult<T> {
  manager: T | null;
  error?: string;
}

export async function withManager<T>(params: {
  getManager: () => Promise<ManagerLookupResult<T>>;
  onMissing: (error?: string) => void;
  run: (manager: T) => Promise<void>;
  close: (manager: T) => Promise<void>;
  onCloseError?: (err: unknown) => void;
}): Promise<void> {
  const { manager, error } = await params.getManager();
  if (!manager) {
    params.onMissing(error);
    return;
  }
  try {
    await params.run(manager);
  } finally {
    try {
      await params.close(manager);
    } catch (error) {
      params.onCloseError?.(error);
    }
  }
}

export async function runCommandWithRuntime(
  runtime: { error: (message: string) => void; exit: (code: number) => void },
  action: () => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (onError) {
      onError(error);
      return;
    }
    runtime.error(String(error));
    runtime.exit(1);
  }
}

export function resolveOptionFromCommand<T>(
  command: Command | undefined,
  key: string,
): T | undefined {
  let current: Command | null | undefined = command;
  while (current) {
    const opts = current.opts?.() ?? {};
    if (opts[key] !== undefined) {
      return opts[key];
    }
    current = current.parent ?? undefined;
  }
  return undefined;
}
