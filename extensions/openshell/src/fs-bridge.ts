import fsPromises from "node:fs/promises";
import path from "node:path";
import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { createWritableRenameTargetResolver } from "openclaw/plugin-sdk/sandbox";
import type { OpenShellFsBridgeContext, OpenShellSandboxBackend } from "./backend.types.js";
import { movePathWithCopyFallback } from "./mirror.js";

type ResolvedMountPath = SandboxResolvedPath & {
  mountHostRoot: string;
  writable: boolean;
  source: "workspace" | "agent";
};

export function createOpenShellFsBridge(params: {
  sandbox: OpenShellFsBridgeContext;
  backend: OpenShellSandboxBackend;
}): SandboxFsBridge {
  return new OpenShellFsBridge(params.sandbox, params.backend);
}

class OpenShellFsBridge implements SandboxFsBridge {
  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(
    private readonly sandbox: OpenShellFsBridgeContext,
    private readonly backend: OpenShellSandboxBackend,
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      containerPath: target.containerPath,
      hostPath: target.hostPath,
      relativePath: target.relativePath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: false,
      allowMissingLeaf: false,
      root: target.mountHostRoot,
      target,
    });
    return await fsPromises.readFile(hostPath);
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "write files");
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: false,
      allowMissingLeaf: true,
      root: target.mountHostRoot,
      target,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const parentDir = path.dirname(hostPath);
    if (params.mkdir !== false) {
      await fsPromises.mkdir(parentDir, { recursive: true });
    }
    const tempPath = path.join(
      parentDir,
      `.openclaw-openshell-write-${path.basename(hostPath)}-${process.pid}-${Date.now()}`,
    );
    await fsPromises.writeFile(tempPath, buffer);
    await fsPromises.rename(tempPath, hostPath);
    await this.backend.syncLocalPathToRemote(hostPath, target.containerPath);
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "create directories");
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: false,
      allowMissingLeaf: true,
      root: target.mountHostRoot,
      target,
    });
    await fsPromises.mkdir(hostPath, { recursive: true });
    await this.backend.runRemoteShellScript({
      args: [target.containerPath],
      script: 'mkdir -p -- "$1"',
      signal: params.signal,
    });
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "remove files");
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: true,
      allowMissingLeaf: params.force !== false,
      root: target.mountHostRoot,
      target,
    });
    await fsPromises.rm(hostPath, {
      force: params.force !== false,
      recursive: params.recursive ?? false,
    });
    await this.backend.runRemoteShellScript({
      allowFailure: params.force !== false,
      args: [target.containerPath],
      script: params.recursive
        ? 'rm -rf -- "$1"'
        : 'if [ -d "$1" ] && [ ! -L "$1" ]; then rmdir -- "$1"; elif [ -e "$1" ] || [ -L "$1" ]; then rm -f -- "$1"; fi',
      signal: params.signal,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { from, to } = this.resolveRenameTargets(params);
    const fromHostPath = this.requireHostPath(from);
    const toHostPath = this.requireHostPath(to);
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: true,
      allowMissingLeaf: false,
      root: from.mountHostRoot,
      target: from,
    });
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: false,
      allowMissingLeaf: true,
      root: to.mountHostRoot,
      target: to,
    });
    await fsPromises.mkdir(path.dirname(toHostPath), { recursive: true });
    await movePathWithCopyFallback({ from: fromHostPath, to: toHostPath });
    await this.backend.runRemoteShellScript({
      args: [from.containerPath, to.containerPath],
      script: 'mkdir -p -- "$(dirname -- "$2")" && mv -- "$1" "$2"',
      signal: params.signal,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    const stats = await fsPromises.lstat(hostPath).catch(() => null);
    if (!stats) {
      return null;
    }
    await assertLocalPathSafety({
      allowFinalSymlinkForUnlink: false,
      allowMissingLeaf: false,
      root: target.mountHostRoot,
      target,
    });
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      type: stats.isDirectory() ? "directory" : (stats.isFile() ? "file" : "other"),
    };
  }

  private ensureWritable(target: ResolvedMountPath, action: string) {
    if (this.sandbox.workspaceAccess !== "rw" || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private requireHostPath(target: ResolvedMountPath): string {
    if (!target.hostPath) {
      throw new Error(
        `OpenShell mirror bridge requires a local host path: ${target.containerPath}`,
      );
    }
    return target.hostPath;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedMountPath {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
    const hasAgentMount = this.sandbox.workspaceAccess !== "none" && workspaceRoot !== agentRoot;
    const agentContainerRoot = (this.backend.remoteAgentWorkspaceDir || "/agent").replace(
      /\\/g,
      "/",
    );
    const workspaceContainerRoot = this.sandbox.containerWorkdir.replace(/\\/g, "/");
    const input = params.filePath.trim();

    if (input.startsWith(`${workspaceContainerRoot}/`) || input === workspaceContainerRoot) {
      const relative = path.posix.relative(workspaceContainerRoot, input) || "";
      const hostPath = relative
        ? path.resolve(workspaceRoot, ...relative.split("/"))
        : workspaceRoot;
      return {
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        hostPath,
        mountHostRoot: workspaceRoot,
        relativePath: relative,
        source: "workspace",
        writable: this.sandbox.workspaceAccess === "rw",
      };
    }

    if (
      hasAgentMount &&
      (input.startsWith(`${agentContainerRoot}/`) || input === agentContainerRoot)
    ) {
      const relative = path.posix.relative(agentContainerRoot, input) || "";
      const hostPath = relative ? path.resolve(agentRoot, ...relative.split("/")) : agentRoot;
      return {
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        hostPath,
        mountHostRoot: agentRoot,
        relativePath: relative ? agentContainerRoot + "/" + relative : agentContainerRoot,
        source: "agent",
        writable: this.sandbox.workspaceAccess === "rw",
      };
    }

    const cwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
    const hostPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);

    if (isPathInside(workspaceRoot, hostPath)) {
      const relative = path.relative(workspaceRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        hostPath,
        mountHostRoot: workspaceRoot,
        relativePath: relative,
        source: "workspace",
        writable: this.sandbox.workspaceAccess === "rw",
      };
    }

    if (hasAgentMount && isPathInside(agentRoot, hostPath)) {
      const relative = path.relative(agentRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        hostPath,
        mountHostRoot: agentRoot,
        relativePath: relative ? `${agentContainerRoot}/${relative}` : agentContainerRoot,
        source: "agent",
        writable: this.sandbox.workspaceAccess === "rw",
      };
    }

    throw new Error(`Path escapes sandbox root (${workspaceRoot}): ${params.filePath}`);
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertLocalPathSafety(params: {
  target: ResolvedMountPath;
  root: string;
  allowMissingLeaf: boolean;
  allowFinalSymlinkForUnlink: boolean;
}): Promise<void> {
  if (!params.target.hostPath) {
    throw new Error(`Missing local host path for ${params.target.containerPath}`);
  }
  const canonicalRoot = await fsPromises
    .realpath(params.root)
    .catch(() => path.resolve(params.root));
  const candidate = await resolveCanonicalCandidate(params.target.hostPath);
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`,
    );
  }

  const relative = path.relative(params.root, params.target.hostPath);
  const segments = relative
    .split(path.sep)
    .filter(Boolean)
    .slice(0, Math.max(0, relative.split(path.sep).filter(Boolean).length));
  let cursor = params.root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stats = await fsPromises.lstat(cursor).catch(() => null);
    if (!stats) {
      if (index === segments.length - 1 && params.allowMissingLeaf) {
        return;
      }
      continue;
    }
    const isFinal = index === segments.length - 1;
    if (stats.isSymbolicLink() && (!isFinal || !params.allowFinalSymlinkForUnlink)) {
      throw new Error(`Sandbox boundary checks failed: ${params.target.containerPath}`);
    }
  }
}

async function resolveCanonicalCandidate(targetPath: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    const exists = await fsPromises
      .lstat(cursor)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const canonical = await fsPromises.realpath(cursor).catch(() => cursor);
      return path.resolve(canonical, ...missing);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return path.resolve(cursor, ...missing);
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}
