/**
 * ChildProcess wrapper interface for cross-runtime compatibility.
 * Provides a unified ChildProcess-like API across Bun and Node.js.
 */

import type { ChildProcess as NodeChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Minimal readable stream interface for stdin/stdout/stderr
 */
export interface SubprocessStream {
  write(data: string | Buffer): boolean;
  end(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  pipe(destination: unknown): unknown;
  isTTY?: boolean;
}

/**
 * ChildProcess wrapper interface that mimics Node.js ChildProcess
 */
export interface ChildProcessWrapper extends EventEmitter {
  /** Process ID */
  pid?: number;
  /** Standard input stream */
  stdin: SubprocessStream | null;
  /** Standard output stream */
  stdout: SubprocessStream | null;
  /** Standard error stream */
  stderr: SubprocessStream | null;
  /** Standard I/O configuration */
  stdio: [
    SubprocessStream | null,
    SubprocessStream | null,
    SubprocessStream | null,
    ...SubprocessStream[],
  ];
  /** Whether the process is connected to its IPC channel */
  connected: boolean;
  /** Exit code (set after process exits) */
  exitCode: number | null;
  /** Signal that caused process termination (if applicable) */
  signalCode: NodeJS.Signals | null;
  /** Whether the process was killed */
  killed: boolean;

  /** Kill the subprocess */
  kill(signal?: NodeJS.Signals): boolean;
  /** Send a message to the child process (IPC) */
  send(message: unknown, sendHandle?: unknown, options?: unknown): boolean;
  /** Disconnect the IPC channel */
  disconnect(): void;
  /** Unref the process (allow parent to exit independently) */
  unref(): void;
  /** Ref the process */
  ref(): void;

  /** Events: 'close', 'disconnect', 'error', 'exit', 'message', 'spawn' */
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  addListener(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Factory for creating ChildProcess wrappers
 */
export interface ChildProcessWrapperFactory {
  createWrapper(
    command: string,
    args: string[],
    options: SubprocessWrapperOptions,
  ): ChildProcessWrapper;
}

export interface SubprocessWrapperOptions {
  cwd?: string | URL;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe' | 'ignore' | Array<'inherit' | 'pipe' | 'ignore'>;
  detached?: boolean;
  shell?: boolean | string;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}
