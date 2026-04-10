import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxContext } from "../sandbox.js";
import type { SandboxFsBridge, SandboxResolvedPath } from "../sandbox/fs-bridge.js";
import { createSandboxFsBridgeFromResolver } from "./host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "./pi-tools-sandbox-context.js";

export function createUnsafeMountedBridge(params: {
  root: string;
  agentHostRoot: string;
  workspaceContainerRoot?: string;
}): SandboxFsBridge {
  const root = path.resolve(params.root);
  const agentHostRoot = path.resolve(params.agentHostRoot);
  const workspaceContainerRoot = params.workspaceContainerRoot ?? "/workspace";

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    // Intentionally unsafe: simulate a sandbox FS bridge that maps /agent/* into a host path
    // Outside the workspace root (e.g. an operator-configured bind mount).
    const hostPath =
      filePath === "/agent" || filePath === "/agent/" || filePath.startsWith("/agent/")
        ? path.join(
            agentHostRoot,
            filePath === "/agent" || filePath === "/agent/" ? "" : filePath.slice("/agent/".length),
          )
        : (path.isAbsolute(filePath)
          ? filePath
          : path.resolve(cwd ?? root, filePath));

    const relFromRoot = path.relative(root, hostPath);
    const relativePath =
      relFromRoot && !relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot)
        ? relFromRoot.split(path.sep).filter(Boolean).join(path.posix.sep)
        : filePath.replace(/\\/g, "/");

    const containerPath = filePath.startsWith("/")
      ? filePath.replace(/\\/g, "/")
      : (relativePath
        ? path.posix.join(workspaceContainerRoot, relativePath)
        : workspaceContainerRoot);

    return { containerPath, hostPath, relativePath };
  };

  return createSandboxFsBridgeFromResolver(resolvePath);
}

export function createUnsafeMountedSandbox(params: {
  sandboxRoot: string;
  agentRoot: string;
  workspaceContainerRoot?: string;
}): SandboxContext {
  const bridge = createUnsafeMountedBridge({
    agentHostRoot: params.agentRoot,
    root: params.sandboxRoot,
    workspaceContainerRoot: params.workspaceContainerRoot,
  });
  return createPiToolsSandboxContext({
    agentWorkspaceDir: params.agentRoot,
    fsBridge: bridge,
    tools: { allow: [], deny: [] },
    workspaceAccess: "rw",
    workspaceDir: params.sandboxRoot,
  });
}

export async function withUnsafeMountedSandboxHarness(
  run: (ctx: { sandboxRoot: string; agentRoot: string; sandbox: SandboxContext }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-mounts-"));
  const sandboxRoot = path.join(stateDir, "sandbox");
  const agentRoot = path.join(stateDir, "agent");
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.mkdir(agentRoot, { recursive: true });
  const sandbox = createUnsafeMountedSandbox({ agentRoot, sandboxRoot });
  try {
    await run({ agentRoot, sandbox, sandboxRoot });
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
}
