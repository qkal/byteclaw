import { type ExecFileOptionsWithStringEncoding, execFile } from "node:child_process";

export interface ExecResult { stdout: string; stderr: string; code: number }

export async function execFileUtf8(
  command: string,
  args: string[],
  options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          code: 0,
          stderr: String(stderr ?? ""),
          stdout: String(stdout ?? ""),
        });
        return;
      }

      const e = error as { code?: unknown; message?: unknown };
      const stderrText = String(stderr ?? "");
      resolve({
        code: typeof e.code === "number" ? e.code : 1,
        stderr:
          stderrText ||
          (typeof e.message === "string" ? e.message : (typeof error === "string" ? error : "")),
        stdout: String(stdout ?? ""),
      });
    });
  });
}
