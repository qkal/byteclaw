import type { RuntimeEnv } from "../../runtime.js";
import {
  addFallbackCommand,
  clearFallbacksCommand,
  listFallbacksCommand,
  removeFallbackCommand,
} from "./fallbacks-shared.js";

export async function modelsFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  return await listFallbacksCommand({ key: "model", label: "Fallbacks" }, opts, runtime);
}

export async function modelsFallbacksAddCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await addFallbackCommand(
    { key: "model", label: "Fallbacks", logPrefix: "Fallbacks" },
    modelRaw,
    runtime,
  );
}

export async function modelsFallbacksRemoveCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await removeFallbackCommand(
    {
      key: "model",
      label: "Fallbacks",
      logPrefix: "Fallbacks",
      notFoundLabel: "Fallback",
    },
    modelRaw,
    runtime,
  );
}

export async function modelsFallbacksClearCommand(runtime: RuntimeEnv) {
  return await clearFallbacksCommand(
    { clearedMessage: "Fallback list cleared.", key: "model" },
    runtime,
  );
}
