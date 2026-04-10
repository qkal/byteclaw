import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout } from "../process/exec.js";

export interface PluginCommandRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PluginCommandRunOptions {
  argv: string[];
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run a plugin-managed command with timeout handling and normalized stdout/stderr results. */
export async function runPluginCommandWithTimeout(
  options: PluginCommandRunOptions,
): Promise<PluginCommandRunResult> {
  const [command] = options.argv;
  if (!command) {
    return { code: 1, stderr: "command is required", stdout: "" };
  }

  try {
    const result = await runCommandWithTimeout(options.argv, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    const timedOut = result.termination === "timeout" || result.termination === "no-output-timeout";
    return {
      code: result.code ?? 1,
      stderr: timedOut
        ? result.stderr || `command timed out after ${options.timeoutMs}ms`
        : result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    return {
      code: 1,
      stderr: formatErrorMessage(error),
      stdout: "",
    };
  }
}
