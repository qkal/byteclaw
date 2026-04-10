/**
 * Runtime detection utilities for Bun-first execution with Node fallback.
 * Provides a consistent interface to detect and work with different runtimes.
 */

/**
 * Detects if the current runtime is Bun.
 */
export function isBun(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (
    typeof (globalThis as any).Bun !== 'undefined' &&
    !!(globalThis as any).Bun.version
  );
}

/**
 * Detects if the current runtime is Node.js.
 */
export function isNode(): boolean {
  return !isBun();
}

/**
 * Returns the current runtime name.
 */
export function getRuntime(): 'bun' | 'node' {
  return isBun() ? 'bun' : 'node';
}

/**
 * Returns the current runtime version.
 */
export function getRuntimeVersion(): string {
  if (isBun()) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return Bun.version;
  }
  return process.version;
}

/**
 * Runtime-aware error reporting that includes runtime information.
 */
export function withRuntimeContext(message: string): string {
  return `[${getRuntime()} ${getRuntimeVersion()}] ${message}`;
}

/**
 * Logs runtime information for debugging.
 */
export function logRuntimeInfo(): void {
  console.debug(withRuntimeContext(`Runtime detected`));
}

/**
 * Environment variable to force runtime selection.
 * Set OPENCLAW_RUNTIME=bun or OPENCLAW_RUNTIME=node to override detection.
 */
export function getForcedRuntime(): 'bun' | 'node' | null {
  const forced = process.env.OPENCLAW_RUNTIME?.toLowerCase();
  if (forced === 'bun') return 'bun';
  if (forced === 'node') return 'node';
  return null;
}

/**
 * Returns the effective runtime, accounting for forced override.
 */
export function getEffectiveRuntime(): 'bun' | 'node' {
  const forced = getForcedRuntime();
  if (forced) {
    console.warn(
      withRuntimeContext(`Runtime forced to ${forced} via OPENCLAW_RUNTIME`),
    );
    return forced;
  }
  return getRuntime();
}
