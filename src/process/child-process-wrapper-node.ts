/**
 * Node.js implementation of ChildProcess wrapper.
 * Delegates to the actual Node.js ChildProcess.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess as NodeChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  ChildProcessWrapper,
  SubprocessStream,
  SubprocessWrapperOptions,
} from './child-process-wrapper.js';

/**
 * Node.js ChildProcess wrapper that delegates to the actual ChildProcess
 */
export class NodeChildProcessWrapper
  extends EventEmitter
  implements ChildProcessWrapper
{
  readonly #child: NodeChildProcess;

  constructor(child: NodeChildProcess) {
    super();
    this.#child = child;

    // Forward all events from the actual child process
    this.#child.on('close', (...args) => this.emit('close', ...args));
    this.#child.on('disconnect', (...args) => this.emit('disconnect', ...args));
    this.#child.on('error', (...args) => this.emit('error', ...args));
    this.#child.on('exit', (...args) => this.emit('exit', ...args));
    this.#child.on('message', (...args) => this.emit('message', ...args));
    this.#child.on('spawn', (...args) => this.emit('spawn', ...args));
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stdin(): SubprocessStream | null {
    return this.#child.stdin as SubprocessStream | null;
  }

  get stdout(): SubprocessStream | null {
    return this.#child.stdout as SubprocessStream | null;
  }

  get stderr(): SubprocessStream | null {
    return this.#child.stderr as SubprocessStream | null;
  }

  get stdio(): [
    SubprocessStream | null,
    SubprocessStream | null,
    SubprocessStream | null,
    ...SubprocessStream[],
  ] {
    return this.#child.stdio as [
      SubprocessStream | null,
      SubprocessStream | null,
      SubprocessStream | null,
      ...SubprocessStream[],
    ];
  }

  get connected(): boolean {
    return this.#child.connected;
  }

  get exitCode(): number | null {
    return this.#child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#child.signalCode;
  }

  get killed(): boolean {
    return this.#child.killed;
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.#child.kill(signal);
  }

  send(message: unknown, sendHandle?: unknown, options?: unknown): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.#child.send(message as any, sendHandle as any, options as any);
  }

  disconnect(): void {
    this.#child.disconnect();
  }

  unref(): void {
    this.#child.unref();
  }

  ref(): void {
    this.#child.ref();
  }

  // Override EventEmitter methods to delegate to the actual child
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.#child.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.#child.off(event, listener);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    this.#child.once(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    return this.#child.emit(event, ...args);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.#child.removeListener(event, listener);
    return this;
  }

  addListener(event: string, listener: (...args: unknown[]) => void): this {
    this.#child.addListener(event, listener);
    return this;
  }
}

/**
 * Factory for creating Node ChildProcess wrappers
 */
export function createNodeChildProcessWrapper(
  command: string,
  args: string[],
  options: SubprocessWrapperOptions,
): ChildProcessWrapper {
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'pipe',
    detached: options.detached ?? false,
    shell: options.shell ?? false,
    windowsHide: options.windowsHide,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });

  return new NodeChildProcessWrapper(child);
}
