import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGlobalCommandRunner } from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout,
}));

describe("createGlobalCommandRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandWithTimeout.mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "exit",
    });
  });

  it("forwards argv/options and maps exec result shape", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      code: 17,
      killed: false,
      signal: null,
      stderr: "err",
      stdout: "out",
      termination: "exit",
    });
    const runCommand = createGlobalCommandRunner();

    const result = await runCommand(["npm", "root", "-g"], {
      cwd: "/tmp/openclaw",
      env: { OPENCLAW_TEST: "1" },
      timeoutMs: 1200,
    });

    expect(runCommandWithTimeout).toHaveBeenCalledWith(["npm", "root", "-g"], {
      cwd: "/tmp/openclaw",
      env: { OPENCLAW_TEST: "1" },
      timeoutMs: 1200,
    });
    expect(result).toEqual({
      code: 17,
      stderr: "err",
      stdout: "out",
    });
  });
});
