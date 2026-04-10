/**
 * Runtime-aware subprocess module.
 * Automatically selects the appropriate subprocess abstraction based on the current runtime.
 */

import { getEffectiveRuntime } from '../shared/runtime-detection.js';
import { BunSubprocessAbstraction } from './subprocess-bun.js';
import { NodeSubprocessAbstraction } from './subprocess-node.js';
import type {
  SubprocessAbstraction,
  SubprocessOptions,
  SubprocessResult,
  SubprocessSpawnResult,
} from './subprocess-abstraction.js';

export type { SubprocessOptions, SubprocessResult, SubprocessSpawnResult };

let subprocessAbstraction: SubprocessAbstraction | null = null;

function getAbstraction(): SubprocessAbstraction {
  if (!subprocessAbstraction) {
    const runtime = getEffectiveRuntime();

    if (runtime === 'bun') {
      const bunAbstraction = new BunSubprocessAbstraction();
      if (bunAbstraction.isAvailable()) {
        subprocessAbstraction = bunAbstraction;
      } else {
        // Fallback to Node if Bun abstraction not available
        subprocessAbstraction = new NodeSubprocessAbstraction();
      }
    } else {
      subprocessAbstraction = new NodeSubprocessAbstraction();
    }
  }

  return subprocessAbstraction;
}

/**
 * Execute a command and wait for completion.
 */
export async function exec(
  command: string,
  args: string[],
  options?: SubprocessOptions,
): Promise<SubprocessResult> {
  return getAbstraction().exec(command, args, options);
}

/**
 * Spawn a command and return a handle for interaction.
 */
export function spawn(
  command: string,
  args: string[],
  options?: SubprocessOptions,
): SubprocessSpawnResult {
  return getAbstraction().spawn(command, args, options);
}

/**
 * Reset the subprocess abstraction (useful for testing).
 */
export function resetAbstraction(): void {
  subprocessAbstraction = null;
}
