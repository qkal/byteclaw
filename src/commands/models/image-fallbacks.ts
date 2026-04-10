import type { RuntimeEnv } from "../../runtime.js";
import {
  addFallbackCommand,
  clearFallbacksCommand,
  listFallbacksCommand,
  removeFallbackCommand,
} from "./fallbacks-shared.js";

export async function modelsImageFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  return await listFallbacksCommand({ key: "imageModel", label: "Image fallbacks" }, opts, runtime);
}

export async function modelsImageFallbacksAddCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await addFallbackCommand(
    { key: "imageModel", label: "Image fallbacks", logPrefix: "Image fallbacks" },
    modelRaw,
    runtime,
  );
}

export async function modelsImageFallbacksRemoveCommand(modelRaw: string, runtime: RuntimeEnv) {
  return await removeFallbackCommand(
    {
      key: "imageModel",
      label: "Image fallbacks",
      logPrefix: "Image fallbacks",
      notFoundLabel: "Image fallback",
    },
    modelRaw,
    runtime,
  );
}

export async function modelsImageFallbacksClearCommand(runtime: RuntimeEnv) {
  return await clearFallbacksCommand(
    { clearedMessage: "Image fallback list cleared.", key: "imageModel" },
    runtime,
  );
}
