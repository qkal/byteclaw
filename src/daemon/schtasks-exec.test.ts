import { beforeEach, describe, expect, it, vi } from "vitest";
import { execSchtasks } from "./schtasks-exec.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

describe("execSchtasks", () => {
  it("runs schtasks with bounded timeouts", async () => {
    runCommandWithTimeout.mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "ok",
      termination: "exit",
    });

    await expect(execSchtasks(["/Query"])).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: "ok",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["schtasks", "/Query"], {
      noOutputTimeoutMs: 5000,
      timeoutMs: 15_000,
    });
  });

  it("maps a timeout into a non-zero schtasks result", async () => {
    runCommandWithTimeout.mockResolvedValue({
      code: null,
      killed: true,
      signal: "SIGTERM",
      stderr: "",
      stdout: "",
      termination: "timeout",
    });

    await expect(execSchtasks(["/Create"])).resolves.toEqual({
      code: 124,
      stderr: "schtasks timed out after 15000ms",
      stdout: "",
    });
  });
});
