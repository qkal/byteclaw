/**
 * Subprocess abstraction interface for cross-runtime compatibility.
 * Provides a unified API for spawning child processes across Bun and Node.js.
 */

import type { ChildProcessWrapper } from './child-process-wrapper.js';

export interface SubprocessOptions {
  /** Working directory for the subprocess */
  cwd?: string | URL;
  /** Environment variables for the subprocess */
  env?: NodeJS.ProcessEnv;
  /** Standard input/output/error handling */
  stdio?: 'inherit' | 'pipe' | 'ignore' | Array<'inherit' | 'pipe' | 'ignore'>;
  /** Detach the subprocess from parent */
  detached?: boolean;
  /** Shell mode - run command through shell */
  shell?: boolean | string;
  /** Windows-specific: hide the subprocess window */
  windowsHide?: boolean;
  /** Windows-specific: use verbatim arguments */
  windowsVerbatimArguments?: boolean;
}

export interface SubprocessResult {
  /** Exit code */
  exitCode: number | null;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Whether the process was signaled */
  signal?: NodeJS.Signals;
}

export interface SubprocessSpawnResult {
  /** Child process handle (now typed as ChildProcessWrapper) */
  process: ChildProcessWrapper;
  /** Promise that resolves when process exits */
  exitPromise: Promise<SubprocessResult>;
  /** Kill the subprocess */
  kill: (signal?: NodeJS.Signals) => void;
  /** Write to stdin */
  writeStdin: (data: string | Buffer) => void;
  /** Close stdin */
  closeStdin: () => void;
  /** Process ID (if available) */
  pid?: number;
  /** Unref the process (allow parent to exit independently) */
  unref?: () => void;
  /** Add event listener */
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  /** Remove event listener */
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  /** Add one-time event listener */
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface SubprocessAbstraction {
  /**
   * Execute a command and wait for completion.
   */
  exec(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): Promise<SubprocessResult>;

  /**
   * Spawn a command and return a handle for interaction.
   */
  spawn(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): SubprocessSpawnResult;

  /**
   * Check if this abstraction is available for the current runtime.
   */
  isAvailable(): boolean;
}
