import { runCommandWithTimeout } from "../process/exec.js";

const SCHTASKS_TIMEOUT_MS = 15_000;
const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 5000;

export async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS,
    timeoutMs: SCHTASKS_TIMEOUT_MS,
  });
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks timed out after ${SCHTASKS_TIMEOUT_MS}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms`
        : "";
  return {
    code: typeof result.code === "number" ? result.code : result.killed ? 124 : 1,
    stderr: result.stderr || timeoutDetail,
    stdout: result.stdout,
  };
}
