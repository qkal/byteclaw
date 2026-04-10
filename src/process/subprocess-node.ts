/**
 * Node.js subprocess abstraction implementation.
 * Uses Node's child_process module for subprocess management.
 */

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  SubprocessAbstraction,
  SubprocessOptions,
  SubprocessResult,
  SubprocessSpawnResult,
} from './subprocess-abstraction.js';

const execAsync = promisify(exec);

export class NodeSubprocessAbstraction implements SubprocessAbstraction {
  isAvailable(): boolean {
    return true; // Always available in Node.js
  }

  async exec(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): Promise<SubprocessResult> {
    const fullCommand = command + (args.length > 0 ? ' ' + args.join(' ') : '');

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: options?.cwd,
        env: options?.env,
        shell:
          options?.shell === true
            ? undefined
            : (options?.shell as string | undefined),
        windowsHide: options?.windowsHide,
      });

      return {
        exitCode: 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error) {
        return {
          exitCode: (error as { code: number | null }).code as number,
          stdout: (error as { stdout?: string }).stdout?.toString() ?? '',
          stderr:
            (error as { stderr?: string }).stderr?.toString() ?? error.message,
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
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: options?.stdio ?? 'pipe',
      detached: options?.detached ?? false,
      shell: options?.shell ?? false,
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    const exitPromise = new Promise<SubprocessResult>((resolve) => {
      child.on('exit', (code, signal) => {
        resolve({
          exitCode: code,
          stdout,
          stderr,
          signal: signal ?? undefined,
        });
      });
    });

    return {
      process: child,
      exitPromise,
      kill: (signal?: NodeJS.Signals) => child.kill(signal),
      writeStdin: (data: string | Buffer) => {
        if (child.stdin) {
          child.stdin.write(data);
        }
      },
      closeStdin: () => {
        if (child.stdin) {
          child.stdin.end();
        }
      },
      pid: child.pid,
      unref: () => child.unref(),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        child.on(event, listener);
        return child;
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        child.off(event, listener);
        return child;
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        child.once(event, listener);
        return child;
      },
    };
  }
}
