import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolveDockerSpawnInvocation } from "./docker.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-docker-spawn-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("resolveDockerSpawnInvocation", () => {
  it("keeps non-windows invocation unchanged", () => {
    const resolved = resolveDockerSpawnInvocation(["version"], {
      env: {},
      execPath: "/usr/bin/node",
      platform: "darwin",
    });
    expect(resolved).toEqual({
      args: ["version"],
      command: "docker",
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("prefers docker.exe entrypoint over cmd shell fallback on windows", async () => {
    const dir = await createTempDir();
    const exePath = path.join(dir, "docker.exe");
    const cmdPath = path.join(dir, "docker.cmd");
    await writeFile(exePath, "", "utf8");
    await writeFile(cmdPath, `@ECHO off\r\n"%~dp0\\docker.exe" %*\r\n`, "utf8");

    const resolved = resolveDockerSpawnInvocation(["version"], {
      env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
      platform: "win32",
    });

    expect(resolved).toEqual({
      args: ["version"],
      command: exePath,
      shell: undefined,
      windowsHide: true,
    });
  });

  it("rejects unresolved docker.cmd wrappers instead of shelling out", async () => {
    const dir = await createTempDir();
    const cmdPath = path.join(dir, "docker.cmd");
    await mkdir(path.dirname(cmdPath), { recursive: true });
    await writeFile(cmdPath, "@ECHO off\r\necho docker\r\n", "utf8");

    expect(() =>
      resolveDockerSpawnInvocation(["ps"], {
        env: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" },
        execPath: "C:\\node\\node.exe",
        platform: "win32",
      }),
    ).toThrow(
      /wrapper resolved, but no executable\/Node entrypoint could be resolved without shell execution\./i,
    );
  });
});
