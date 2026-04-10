/**
 * Bun subprocess abstraction implementation.
 * Uses Bun's subprocess API for improved performance.
 */

import type {
  SubprocessAbstraction,
  SubprocessOptions,
  SubprocessResult,
  SubprocessSpawnResult,
} from './subprocess-abstraction.js';

export class BunSubprocessAbstraction implements SubprocessAbstraction {
  isAvailable(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof (globalThis as any).Bun !== 'undefined';
  }

  async exec(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): Promise<SubprocessResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Bun = (globalThis as any).Bun;

    const fullCommand = command + (args.length > 0 ? ' ' + args.join(' ') : '');

    try {
      const proc = Bun.spawn({
        cmd: options?.shell ? ['sh', '-c', fullCommand] : [command, ...args],
        cwd: options?.cwd,
        env: options?.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const stdout = await new Response(proc.stdout).arrayBuffer();
      const stderr = await new Response(proc.stderr).arrayBuffer();
      const exitCode = await proc.exited;

      return {
        exitCode,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: error.message,
        };
      }
      throw error;
    }
  }

  spawn(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): SubprocessSpawnResult {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Bun = (globalThis as any).Bun;

    const proc = Bun.spawn({
      cmd: options?.shell
        ? ['sh', '-c', command + ' ' + args.join(' ')]
        : [command, ...args],
      cwd: options?.cwd,
      env: options?.env,
      stdout:
        options?.stdio === 'pipe' || options?.stdio === undefined
          ? 'pipe'
          : 'inherit',
      stderr:
        options?.stdio === 'pipe' || options?.stdio === undefined
          ? 'pipe'
          : 'inherit',
      stdin:
        options?.stdio === 'pipe' || options?.stdio === undefined
          ? 'pipe'
          : 'inherit',
    });

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      const reader = proc.stdout.getReader();
      const readStream = async () => {
        const { done, value } = await reader.read();
        if (!done) {
          stdout += new TextDecoder().decode(value);
          await readStream();
        }
      };
      readStream().catch(() => {});
    }

    if (proc.stderr) {
      const reader = proc.stderr.getReader();
      const readStream = async () => {
        const { done, value } = await reader.read();
        if (!done) {
          stderr += new TextDecoder().decode(value);
          await readStream();
        }
      };
      readStream().catch(() => {});
    }

    const exitPromise = new Promise<SubprocessResult>((resolve) => {
      proc.exited.then((exitCode: number) => {
        resolve({
          exitCode,
          stdout,
          stderr,
        });
      });
    });

    // Event listener emulation for Bun
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    return {
      process: proc,
      exitPromise,
      kill: (signal?: NodeJS.Signals) => {
        const signalNum = signal
          ? typeof signal === 'number'
            ? signal
            : undefined
          : undefined;
        proc.kill(signalNum as number | undefined);
      },
      writeStdin: (data: string | Buffer) => {
        if (proc.stdin) {
          const writer = proc.stdin.getWriter();
          writer.write(
            typeof data === 'string' ? new TextEncoder().encode(data) : data,
          );
          writer.releaseLock();
        }
      },
      closeStdin: () => {
        if (proc.stdin) {
          proc.stdin.end();
        }
      },
      pid: proc.pid,
      unref: () => {
        // Bun doesn't have unref, this is a no-op
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(listener);
        return proc;
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        const eventListeners = listeners.get(event);
        if (eventListeners) {
          eventListeners.delete(listener);
        }
        return proc;
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        const wrappedListener = (...args: unknown[]) => {
          listener(...args);
          const eventListeners = listeners.get(event);
          if (eventListeners) {
            eventListeners.delete(wrappedListener);
          }
        };
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(wrappedListener);
        return proc;
      },
    };
  }
}
