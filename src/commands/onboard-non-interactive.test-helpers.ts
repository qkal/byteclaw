import fs from "node:fs/promises";
import type { RuntimeEnv } from "../runtime.js";

type RuntimeLike = Pick<RuntimeEnv, "log" | "error" | "exit">;

export interface NonInteractiveRuntime {
  log: RuntimeLike["log"];
  error: RuntimeLike["error"];
  exit: RuntimeLike["exit"];
}

const NON_INTERACTIVE_DEFAULT_OPTIONS = {
  json: true,
  nonInteractive: true,
  skipChannels: true,
  skipHealth: true,
} as const;

export function createThrowingRuntime(): NonInteractiveRuntime {
  return {
    error: (...args: unknown[]) => {
      throw new Error(args.map(String).join(" "));
    },
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
    log: () => {},
  };
}

export async function runNonInteractiveSetup(
  options: Record<string, unknown>,
  runtime: NonInteractiveRuntime,
): Promise<void> {
  const { runNonInteractiveSetup: run } = await import("./onboard-non-interactive.js");
  await run(options, runtime);
}

export async function runNonInteractiveSetupWithDefaults(
  runtime: NonInteractiveRuntime,
  options: Record<string, unknown>,
): Promise<void> {
  await runNonInteractiveSetup(
    {
      ...NON_INTERACTIVE_DEFAULT_OPTIONS,
      ...options,
    },
    runtime,
  );
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
