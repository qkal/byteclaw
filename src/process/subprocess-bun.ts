/**
 * Bun subprocess abstraction implementation.
 * Uses Bun's subprocess API for improved performance.
 */

import type { ChildProcessWrapper, SubprocessWrapperOptions } from "./child-process-wrapper.js";
import { createBunChildProcessWrapper } from "./child-process-wrapper-bun.js";
import type {
  SubprocessAbstraction,
  SubprocessOptions,
  SubprocessResult,
  SubprocessSpawnResult,
} from "./subprocess-abstraction.js";

export class BunSubprocessAbstraction implements SubprocessAbstraction {
  isAvailable(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof (globalThis as any).Bun !== "undefined";
  }

  async exec(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): Promise<SubprocessResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Bun = (globalThis as any).Bun;

    const fullCommand = command + (args.length > 0 ? " " + args.join(" ") : "");

    try {
      const proc = Bun.spawn({
        cmd: options?.shell ? ["sh", "-c", fullCommand] : [command, ...args],
        cwd: options?.cwd,
        env: options?.env,
        stdout: "pipe",
        stderr: "pipe",
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
          stdout: "",
          stderr: error.message,
        };
      }
      throw error;
    }
  }

  spawn(command: string, args: string[], options?: SubprocessOptions): SubprocessSpawnResult {
    const wrapper = createBunChildProcessWrapper(
      command,
      args,
      options as SubprocessWrapperOptions,
    );

    let stdout = "";
    let stderr = "";

    if (wrapper.stdout) {
      wrapper.stdout.on("data", (...args: unknown[]) => {
        const chunk = args[0] as Buffer;
        stdout += chunk.toString();
      });
    }

    if (wrapper.stderr) {
      wrapper.stderr.on("data", (...args: unknown[]) => {
        const chunk = args[0] as Buffer;
        stderr += chunk.toString();
      });
    }

    const exitPromise = new Promise<SubprocessResult>((resolve) => {
      wrapper.on("exit", (...args: unknown[]) => {
        const code = args[0] as number | null;
        const signal = args[1] as NodeJS.Signals | null;
        resolve({
          exitCode: code ?? null,
          stdout,
          stderr,
          signal: signal ?? undefined,
        });
      });
    });

    return {
      process: wrapper,
      exitPromise,
      kill: (signal?: NodeJS.Signals) => wrapper.kill(signal),
      writeStdin: (data: string | Buffer) => {
        if (wrapper.stdin) {
          wrapper.stdin.write(data);
        }
      },
      closeStdin: () => {
        if (wrapper.stdin) {
          wrapper.stdin.end();
        }
      },
      pid: wrapper.pid,
      unref: () => wrapper.unref(),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        wrapper.on(event, listener);
        return wrapper;
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        wrapper.off(event, listener);
        return wrapper;
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        wrapper.once(event, listener);
        return wrapper;
      },
    };
  }
}
