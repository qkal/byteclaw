/**
 * Node.js subprocess abstraction implementation.
 * Uses Node's child_process module for subprocess management.
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcessWrapper, SubprocessWrapperOptions } from "./child-process-wrapper.js";
import { createNodeChildProcessWrapper } from "./child-process-wrapper-node.js";
import type {
  SubprocessAbstraction,
  SubprocessOptions,
  SubprocessResult,
  SubprocessSpawnResult,
} from "./subprocess-abstraction.js";

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
    const fullCommand = command + (args.length > 0 ? " " + args.join(" ") : "");

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: options?.cwd,
        env: options?.env,
        shell: options?.shell === true ? undefined : (options?.shell as string | undefined),
        windowsHide: options?.windowsHide,
      });

      return {
        exitCode: 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error) {
        return {
          exitCode: (error as { code: number | null }).code as number,
          stdout: (error as { stdout?: string }).stdout?.toString() ?? "",
          stderr: (error as { stderr?: string }).stderr?.toString() ?? error.message,
        };
      }
      throw error;
    }
  }

  spawn(command: string, args: string[], options?: SubprocessOptions): SubprocessSpawnResult {
    const wrapper = createNodeChildProcessWrapper(
      command,
      args,
      options as SubprocessWrapperOptions,
    );

    const exitPromise = new Promise<SubprocessResult>((resolve) => {
      wrapper.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        resolve({
          exitCode: code ?? null,
          stdout: "",
          stderr: "",
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
