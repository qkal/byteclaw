import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxFsBridgeContext,
} from "./backend-handle.types.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import { createWritableRenameTargetResolver } from "./fs-bridge-rename-targets.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.types.js";
import {
  isPathInsideContainerRoot,
  normalizeContainerPath as normalizeSandboxContainerPath,
} from "./path-utils.js";

type ResolvedRemotePath = SandboxResolvedPath & {
  writable: boolean;
  mountRootPath: string;
  source: "workspace" | "agent";
};

interface MountInfo {
  containerRoot: string;
  writable: boolean;
  source: "workspace" | "agent";
}

export interface RemoteShellSandboxHandle {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
}

export function createRemoteShellSandboxFsBridge(params: {
  sandbox: SandboxFsBridgeContext;
  runtime: RemoteShellSandboxHandle;
}): SandboxFsBridge {
  return new RemoteShellSandboxFsBridge(params.sandbox, params.runtime);
}

class RemoteShellSandboxFsBridge implements SandboxFsBridge {
  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(
    private readonly sandbox: SandboxFsBridgeContext,
    private readonly runtime: RemoteShellSandboxHandle,
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      containerPath: target.containerPath,
      relativePath: target.relativePath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    const relativePath = path.posix.relative(target.mountRootPath, target.containerPath);
    if (
      relativePath === "" ||
      relativePath === "." ||
      relativePath.startsWith("..") ||
      path.posix.isAbsolute(relativePath)
    ) {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const result = await this.runMutation({
      args: [
        "read",
        target.mountRootPath,
        path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath),
        path.posix.basename(relativePath),
      ],
      signal: params.signal,
    });
    return result.stdout;
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
    this.ensureWritable(target, "write files");
    const pinned = await this.resolvePinnedParent({
      action: "write files",
      containerPath: target.containerPath,
      requireWritable: true,
    });
    await this.assertNoHardlinkedFile({
      action: "write files",
      containerPath: target.containerPath,
      signal: params.signal,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    await this.runMutation({
      args: [
        "write",
        pinned.mountRootPath,
        pinned.relativeParentPath,
        pinned.basename,
        params.mkdir !== false ? "1" : "0",
      ],
      signal: params.signal,
      stdin: buffer,
    });
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "create directories");
    const relativePath = path.posix.relative(target.mountRootPath, target.containerPath);
    if (relativePath.startsWith("..") || path.posix.isAbsolute(relativePath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot create directories: ${target.containerPath}`,
      );
    }
    await this.runMutation({
      args: ["mkdirp", target.mountRootPath, relativePath === "." ? "" : relativePath],
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
    this.ensureWritable(target, "remove files");
    const exists = await this.remotePathExists(target.containerPath, params.signal);
    if (!exists) {
      if (params.force === false) {
        throw new Error(`Sandbox path not found; cannot remove files: ${target.containerPath}`);
      }
      return;
    }
    const pinned = await this.resolvePinnedParent({
      action: "remove files",
      allowFinalSymlinkForUnlink: true,
      containerPath: target.containerPath,
      requireWritable: true,
    });
    await this.runMutation({
      allowFailure: params.force !== false,
      args: [
        "remove",
        pinned.mountRootPath,
        pinned.relativeParentPath,
        pinned.basename,
        params.recursive ? "1" : "0",
        params.force === false ? "0" : "1",
      ],
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
    const fromPinned = await this.resolvePinnedParent({
      action: "rename files",
      allowFinalSymlinkForUnlink: true,
      containerPath: from.containerPath,
      requireWritable: true,
    });
    const toPinned = await this.resolvePinnedParent({
      action: "rename files",
      containerPath: to.containerPath,
      requireWritable: true,
    });
    await this.runMutation({
      args: [
        "rename",
        fromPinned.mountRootPath,
        fromPinned.relativeParentPath,
        fromPinned.basename,
        toPinned.mountRootPath,
        toPinned.relativeParentPath,
        toPinned.basename,
        "1",
      ],
      signal: params.signal,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const exists = await this.remotePathExists(target.containerPath, params.signal);
    if (!exists) {
      return null;
    }
    const canonical = await this.resolveCanonicalPath({
      action: "stat files",
      containerPath: target.containerPath,
      signal: params.signal,
    });
    await this.assertNoHardlinkedFile({
      action: "stat files",
      containerPath: canonical,
      signal: params.signal,
    });
    const result = await this.runRemoteScript({
      args: [canonical],
      script: 'set -eu\nstat -c "%F|%s|%Y" -- "$1"',
      signal: params.signal,
    });
    const output = result.stdout.toString("utf8").trim();
    const [kindRaw = "", sizeRaw = "0", mtimeRaw = "0"] = output.split("|");
    return {
      mtimeMs: Number(mtimeRaw) * 1000,
      size: Number(sizeRaw),
      type: kindRaw === "directory" ? "directory" : kindRaw === "regular file" ? "file" : "other",
    };
  }

  private getMounts(): MountInfo[] {
    const mounts: MountInfo[] = [
      {
        containerRoot: normalizeContainerPath(this.runtime.remoteWorkspaceDir),
        source: "workspace",
        writable: this.sandbox.workspaceAccess === "rw",
      },
    ];
    if (
      this.sandbox.workspaceAccess !== "none" &&
      path.resolve(this.sandbox.agentWorkspaceDir) !== path.resolve(this.sandbox.workspaceDir)
    ) {
      mounts.push({
        containerRoot: normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir),
        source: "agent",
        writable: this.sandbox.workspaceAccess === "rw",
      });
    }
    return mounts;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedRemotePath {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
    const workspaceContainerRoot = normalizeContainerPath(this.runtime.remoteWorkspaceDir);
    const agentContainerRoot = normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir);
    const mounts = this.getMounts();
    const input = params.filePath.trim();
    const inputPosix = input.replace(/\\/g, "/");
    const maybeContainerMount = path.posix.isAbsolute(inputPosix)
      ? this.resolveMountByContainerPath(mounts, normalizeContainerPath(inputPosix))
      : null;
    if (maybeContainerMount) {
      return this.toResolvedPath({
        containerPath: normalizeContainerPath(inputPosix),
        mount: maybeContainerMount,
      });
    }

    const hostCwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
    const hostCandidate = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(hostCwd, input);
    if (isPathInside(workspaceRoot, hostCandidate)) {
      const relative = toPosixRelative(workspaceRoot, hostCandidate);
      return this.toResolvedPath({
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        mount: mounts[0],
      });
    }
    if (mounts[1] && isPathInside(agentRoot, hostCandidate)) {
      const relative = toPosixRelative(agentRoot, hostCandidate);
      return this.toResolvedPath({
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        mount: mounts[1],
      });
    }

    if (params.cwd) {
      const cwdPosix = params.cwd.replace(/\\/g, "/");
      if (path.posix.isAbsolute(cwdPosix)) {
        const cwdContainer = normalizeContainerPath(cwdPosix);
        const cwdMount = this.resolveMountByContainerPath(mounts, cwdContainer);
        if (cwdMount) {
          return this.toResolvedPath({
            containerPath: normalizeContainerPath(path.posix.resolve(cwdContainer, inputPosix)),
            mount: cwdMount,
          });
        }
      }
    }

    throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.filePath}`);
  }

  private toResolvedPath(params: { mount: MountInfo; containerPath: string }): ResolvedRemotePath {
    const relative = path.posix.relative(params.mount.containerRoot, params.containerPath);
    if (relative.startsWith("..") || path.posix.isAbsolute(relative)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot access: ${params.containerPath}`,
      );
    }
    return {
      containerPath: params.containerPath,
      mountRootPath: params.mount.containerRoot,
      relativePath:
        params.mount.source === "workspace"
          ? relative === "."
            ? ""
            : relative
          : relative === "."
            ? params.mount.containerRoot
            : `${params.mount.containerRoot}/${relative}`,
      source: params.mount.source,
      writable: params.mount.writable,
    };
  }

  private resolveMountByContainerPath(
    mounts: MountInfo[],
    containerPath: string,
  ): MountInfo | null {
    const ordered = [...mounts].toSorted((a, b) => b.containerRoot.length - a.containerRoot.length);
    for (const mount of ordered) {
      if (isPathInsideContainerRoot(mount.containerRoot, containerPath)) {
        return mount;
      }
    }
    return null;
  }

  private ensureWritable(target: ResolvedRemotePath, action: string) {
    if (this.sandbox.workspaceAccess !== "rw" || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private async remotePathExists(containerPath: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.runRemoteScript({
      args: [containerPath],
      script: 'if [ -e "$1" ] || [ -L "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
      signal,
    });
    return result.stdout.toString("utf8").trim() === "1";
  }

  private async resolveCanonicalPath(params: {
    containerPath: string;
    action: string;
    allowFinalSymlinkForUnlink?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    const script = [
      "set -eu",
      'target="$1"',
      'allow_final="$2"',
      'suffix=""',
      'probe="$target"',
      'if [ "$allow_final" = "1" ] && [ -L "$target" ]; then probe=$(dirname -- "$target"); fi',
      'cursor="$probe"',
      'while [ ! -e "$cursor" ] && [ ! -L "$cursor" ]; do',
      '  parent=$(dirname -- "$cursor")',
      '  if [ "$parent" = "$cursor" ]; then break; fi',
      '  base=$(basename -- "$cursor")',
      '  suffix="/$base$suffix"',
      '  cursor="$parent"',
      "done",
      'canonical=$(readlink -f -- "$cursor")',
      String.raw`printf "%s%s\n" "$canonical" "$suffix"`,
    ].join("\n");
    const result = await this.runRemoteScript({
      args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"],
      script,
      signal: params.signal,
    });
    const canonical = normalizeContainerPath(result.stdout.toString("utf8").trim());
    if (!this.resolveMountByContainerPath(this.getMounts(), canonical)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    return canonical;
  }

  private async assertNoHardlinkedFile(params: {
    containerPath: string;
    action: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const result = await this.runRemoteScript({
      allowFailure: true,
      args: [params.containerPath],
      script: [
        'if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 0; fi',
        'stats=$(stat -c "%F|%h" -- "$1")',
        String.raw`printf "%s\n" "$stats"`,
      ].join("\n"),
      signal: params.signal,
    });
    const output = result.stdout.toString("utf8").trim();
    if (!output) {
      return;
    }
    const [kind = "", linksRaw = "1"] = output.split("|");
    if (kind === "regular file" && Number(linksRaw) > 1) {
      throw new Error(
        `Hardlinked path is not allowed under sandbox mount root: ${params.containerPath}`,
      );
    }
  }

  private async resolvePinnedParent(params: {
    containerPath: string;
    action: string;
    requireWritable?: boolean;
    allowFinalSymlinkForUnlink?: boolean;
  }): Promise<{ mountRootPath: string; relativeParentPath: string; basename: string }> {
    const basename = path.posix.basename(params.containerPath);
    if (!basename || basename === "." || basename === "/") {
      throw new Error(`Invalid sandbox entry target: ${params.containerPath}`);
    }
    const canonicalParent = await this.resolveCanonicalPath({
      action: params.action,
      allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
      containerPath: normalizeContainerPath(path.posix.dirname(params.containerPath)),
    });
    const mount = this.resolveMountByContainerPath(this.getMounts(), canonicalParent);
    if (!mount) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    if (params.requireWritable && !mount.writable) {
      throw new Error(
        `Sandbox path is read-only; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    const relativeParentPath = path.posix.relative(mount.containerRoot, canonicalParent);
    if (relativeParentPath.startsWith("..") || path.posix.isAbsolute(relativeParentPath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
      );
    }
    return {
      basename,
      mountRootPath: mount.containerRoot,
      relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
    };
  }

  private async runMutation(params: {
    args: string[];
    stdin?: Buffer | string;
    signal?: AbortSignal;
    allowFailure?: boolean;
  }): Promise<SandboxBackendCommandResult> {
    return await this.runRemoteScript({
      allowFailure: params.allowFailure,
      args: params.args,
      script: [
        "set -eu",
        "python3 /dev/fd/3 \"$@\" 3<<'PY'",
        SANDBOX_PINNED_MUTATION_PYTHON,
        "PY",
      ].join("\n"),
      signal: params.signal,
      stdin: params.stdin,
    });
  }

  private async runRemoteScript(params: {
    script: string;
    args?: string[];
    stdin?: Buffer | string;
    signal?: AbortSignal;
    allowFailure?: boolean;
  }) {
    return await this.runtime.runRemoteShellScript({
      allowFailure: params.allowFailure,
      args: params.args,
      script: params.script,
      signal: params.signal,
      stdin: params.stdin,
    });
  }
}

function normalizeContainerPath(value: string): string {
  const normalized = normalizeSandboxContainerPath(value.trim() || "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}
