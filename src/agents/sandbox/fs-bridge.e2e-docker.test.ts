import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { buildSandboxCreateArgs, execDocker, execDockerRaw } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import { appendWorkspaceMountArgs } from "./workspace-mounts.js";

async function sandboxImageReady(): Promise<boolean> {
  try {
    const dockerVersion = await execDockerRaw(["version"], { allowFailure: true });
    if (dockerVersion.code !== 0) {
      return false;
    }
    const pythonCheck = await execDockerRaw(
      ["run", "--rm", "--entrypoint", "python3", DEFAULT_SANDBOX_IMAGE, "--version"],
      { allowFailure: true },
    );
    return pythonCheck.code === 0;
  } catch {
    return false;
  }
}

describe("sandbox fs bridge docker e2e", () => {
  it.runIf(process.platform !== "win32")(
    "writes through docker exec using the pinned mutation helper",
    async () => {
      if (!(await sandboxImageReady())) {
        return;
      }

      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fsbridge-e2e-"));
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const suffix = `${process.pid}-${Date.now()}`;
      const containerName = `openclaw-fsbridge-${suffix}`.slice(0, 63);

      try {
        const sandbox = createSandboxTestContext({
          dockerOverrides: {
            containerPrefix: "openclaw-fsbridge-",
            image: DEFAULT_SANDBOX_IMAGE,
            user: "",
          },
          overrides: {
            agentWorkspaceDir: workspaceDir,
            containerName,
            containerWorkdir: "/workspace",
            workspaceDir,
          },
        });

        const createArgs = buildSandboxCreateArgs({
          bindSourceRoots: [workspaceDir],
          cfg: sandbox.docker,
          includeBinds: false,
          name: containerName,
          scopeKey: sandbox.sessionKey,
        });
        createArgs.push("--workdir", sandbox.containerWorkdir);
        appendWorkspaceMountArgs({
          agentWorkspaceDir: workspaceDir,
          args: createArgs,
          workdir: sandbox.containerWorkdir,
          workspaceAccess: sandbox.workspaceAccess,
          workspaceDir,
        });
        createArgs.push(sandbox.docker.image, "sleep", "infinity");

        await execDocker(createArgs);
        await execDocker(["start", containerName]);

        const bridge = createSandboxFsBridge({ sandbox });
        await bridge.writeFile({ data: "from-docker", filePath: "nested/hello.txt" });

        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "hello.txt"), "utf8"),
        ).resolves.toBe("from-docker");
      } finally {
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
        await fs.rm(stateDir, { force: true, recursive: true });
      }
    },
  );
});
