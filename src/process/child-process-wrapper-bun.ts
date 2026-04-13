/**
 * Bun implementation of ChildProcess wrapper.
 * Emulates ChildProcess behavior using Bun's subprocess API.
 */

import { EventEmitter } from 'node:events';
import type {
  ChildProcessWrapper,
  SubprocessStream,
  SubprocessWrapperOptions,
} from './child-process-wrapper.js';

/**
 * Simple stream wrapper for Bun subprocess streams
 */
class BunSubprocessStream implements SubprocessStream {
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #emitter = new EventEmitter();
  #closed = false;

  constructor(
    public stream:
      | ReadableStream<Uint8Array>
      | WritableStream<Uint8Array>
      | null,
    private isReadable: boolean,
  ) {
    if (stream) {
      if (isReadable) {
        this.#reader = (stream as ReadableStream<Uint8Array>).getReader();
        this.#startReading();
      } else {
        this.#writer = (stream as WritableStream<Uint8Array>).getWriter();
      }
    }
  }

  #startReading(): void {
    if (!this.#reader) return;

    const read = async () => {
      try {
        while (true) {
          const result = await this.#reader.read();
          if (!result || result.done) {
            break;
          }
          const { done, value } = result;
          if (done) {
            this.#closed = true;
            this.#emitter.emit('end');
            this.#emitter.emit('close');
            break;
          }
          this.#emitter.emit('data', Buffer.from(value));
        }
      } catch (error) {
        if (!this.#closed) {
          this.#emitter.emit('error', error);
        }
      }
    };
    read();
  }

  write(data: string | Buffer): boolean {
    if (!this.#writer || this.#closed) return false;
    const encoder = new TextEncoder();
    const buffer = typeof data === 'string' ? encoder.encode(data) : data;
    this.#writer.write(buffer);
    return true;
  }

  end(): void {
    if (this.#writer) {
      this.#writer.close();
      this.#closed = true;
    }
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.#emitter.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.#emitter.off(event, listener);
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    this.#emitter.once(event, listener);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.#emitter.removeListener(event, listener);
  }

  pipe(destination: unknown): unknown {
    // Basic pipe implementation
    this.on('data', (chunk) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((destination as any).write) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (destination as any).write(chunk);
      }
    });
    this.on('end', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((destination as any).end) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (destination as any).end();
      }
    });
    return destination;
  }

  get isTTY(): boolean {
    return false;
  }
}

/**
 * Bun ChildProcess wrapper that emulates Node.js ChildProcess using Bun.spawn
 */
export class BunChildProcessWrapper
  extends EventEmitter
  implements ChildProcessWrapper
{
  #process: ReturnType<typeof Bun.spawn> | null;
  #exitCode: number | null = null;
  #signalCode: NodeJS.Signals | null = null;
  #killed = false;
  #connected = false;
  #stdinStream: SubprocessStream | null;
  #stdoutStream: SubprocessStream | null;
  #stderrStream: SubprocessStream | null;

  constructor(
    process: ReturnType<typeof Bun.spawn>,
    stdio: SubprocessWrapperOptions['stdio'],
  ) {
    super();
    this.#process = process;

    // Create stream wrappers
    const usePipe = stdio === 'pipe' || stdio === undefined;
    this.#stdinStream =
      process.stdin && usePipe
        ? new BunSubprocessStream(process.stdin, false)
        : null;
    this.#stdoutStream =
      process.stdout && usePipe
        ? new BunSubprocessStream(process.stdout, true)
        : null;
    this.#stderrStream =
      process.stderr && usePipe
        ? new BunSubprocessStream(process.stderr, true)
        : null;

    // Handle exit
    process.exited.then((exitCode) => {
      this.#exitCode = exitCode;
      this.emit('exit', exitCode, null);
      this.emit('close', exitCode, null);
    });

    // Emit spawn event
    setImmediate(() => {
      this.emit('spawn');
    });
  }

  get pid(): number | undefined {
    return this.#process.pid;
  }

  get stdin(): SubprocessStream | null {
    return this.#stdinStream;
  }

  get stdout(): SubprocessStream | null {
    return this.#stdoutStream;
  }

  get stderr(): SubprocessStream | null {
    return this.#stderrStream;
  }

  get stdio(): [
    SubprocessStream | null,
    SubprocessStream | null,
    SubprocessStream | null,
    ...SubprocessStream[],
  ] {
    return [this.#stdinStream, this.#stdoutStream, this.#stderrStream];
  }

  get connected(): boolean {
    return this.#connected;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode;
  }

  get killed(): boolean {
    return this.#killed;
  }

  kill(signal?: NodeJS.Signals): boolean {
    const signalNum = signal
      ? typeof signal === 'number'
        ? signal
        : undefined
      : undefined;
    this.#killed = true;
    this.#process.kill(signalNum as number | undefined);
    return true;
  }

  send(message: unknown, sendHandle?: unknown, options?: unknown): boolean {
    // IPC not supported in Bun wrapper
    return false;
  }

  disconnect(): void {
    this.#connected = false;
  }

  unref(): void {
    // Bun doesn't have unref, no-op
  }

  ref(): void {
    // Bun doesn't have ref, no-op
  }

  // EventEmitter methods
  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    super.off(event, listener);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    super.once(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    super.removeListener(event, listener);
    return this;
  }

  addListener(event: string, listener: (...args: unknown[]) => void): this {
    super.addListener(event, listener);
    return this;
  }
}

/**
 * Factory for creating Bun ChildProcess wrappers
 */
export function createBunChildProcessWrapper(
  command: string,
  args: string[],
  options: SubprocessWrapperOptions,
): ChildProcessWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun = (globalThis as any).Bun;

  const cmd = options.shell
    ? ['sh', '-c', command + ' ' + args.join(' ')]
    : [command, ...args];

  const usePipe = options.stdio === 'pipe' || options.stdio === undefined;
  const useInherit = options.stdio === 'inherit';

  const process = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdout: usePipe ? 'pipe' : useInherit ? 'inherit' : 'ignore',
    stderr: usePipe ? 'pipe' : useInherit ? 'inherit' : 'ignore',
    stdin: usePipe ? 'pipe' : useInherit ? 'inherit' : 'ignore',
  });

  return new BunChildProcessWrapper(process, options.stdio);
}
