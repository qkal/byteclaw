export type { PluginRuntime } from "../plugins/runtime/types.js";

/** Create a tiny mutable runtime slot with strict access when the runtime has not been initialized. */
export function createPluginRuntimeStore<T>(errorMessage: string): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
} {
  let runtime: T | null = null;

  return {
    clearRuntime() {
      runtime = null;
    },
    getRuntime() {
      if (!runtime) {
        throw new Error(errorMessage);
      }
      return runtime;
    },
    setRuntime(next: T) {
      runtime = next;
    },
    tryGetRuntime() {
      return runtime;
    },
  };
}
