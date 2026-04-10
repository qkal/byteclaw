import { describe, expect, it, vi } from "vitest";
import type { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureBinary } from "./binaries.js";

describe("ensureBinary", () => {
  it("passes through when the binary exists", async () => {
    const exec: typeof runExec = vi.fn().mockResolvedValue({
      stderr: "",
      stdout: "",
    });
    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };

    await ensureBinary("node", exec, runtime);

    expect(exec).toHaveBeenCalledWith("which", ["node"]);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("logs and exits when the binary is missing", async () => {
    const exec: typeof runExec = vi.fn().mockRejectedValue(new Error("missing"));
    const error = vi.fn();
    const exit = vi.fn(() => {
      throw new Error("exit");
    });

    await expect(ensureBinary("ghost", exec, { error, exit, log: vi.fn() })).rejects.toThrow(
      "exit",
    );
    expect(error).toHaveBeenCalledWith("Missing required binary: ghost. Please install it.");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
