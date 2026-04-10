import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginSdkTestHarness } from "./test-helpers.js";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

const { createTempDir } = createPluginSdkTestHarness({
  cleanup: {
    maxRetries: 8,
    retryDelay: 8,
  },
});

describe("resolveWindowsSpawnProgram", () => {
  it("fails closed by default for unresolved windows wrappers", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const shimPath = path.join(dir, "wrapper.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    expect(() =>
      resolveWindowsSpawnProgram({
        command: shimPath,
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toThrow(/without shell execution/);
  });

  it("only returns shell fallback when explicitly opted in", async () => {
    const dir = await createTempDir("openclaw-windows-spawn-test-");
    const shimPath = path.join(dir, "wrapper.cmd");
    await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const resolved = resolveWindowsSpawnProgram({
      allowShellFallback: true,
      command: shimPath,
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      platform: "win32",
    });
    const invocation = materializeWindowsSpawnProgram(resolved, ["--cwd", String.raw`C:\safe & calc.exe`]);

    expect(invocation).toEqual({
      argv: ["--cwd", String.raw`C:\safe & calc.exe`],
      command: shimPath,
      resolution: "shell-fallback",
      shell: true,
      windowsHide: undefined,
    });
  });
});
