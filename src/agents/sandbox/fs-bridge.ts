import fs from "node:fs";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type {
  SandboxBackendCommandResult,
  SandboxFsBridgeContext,
} from "./backend-handle.types.js";
import { runDockerSandboxShellCommand } from "./docker-backend.js";
import {
  buildPinnedMkdirpPlan,
  buildPinnedRemovePlan,
  buildPinnedRenamePlan,
  buildPinnedWritePlan,
} from "./fs-bridge-mutation-helper.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import { type SandboxFsCommandPlan, buildStatPlan } from "./fs-bridge-shell-command-plans.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.types.js";
import {
  type SandboxResolvedFsPath,
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
} from "./fs-paths.js";
import type { SandboxWorkspaceAccess } from "./types.js";

interface RunCommandOptions {
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
}

export type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.types.js";

export function createSandboxFsBridge(params: {
  sandbox: SandboxFsBridgeContext;
}): SandboxFsBridge {
  return new SandboxFsBridgeImpl(params.sandbox);
}

class SandboxFsBridgeImpl implements SandboxFsBridge {
  private readonly sandbox: SandboxFsBridgeContext;
  private readonly mounts: ReturnType<typeof buildSandboxFsMounts>;
  private readonly pathGuard: SandboxFsPathGuard;

  constructor(sandbox: SandboxFsBridgeContext) {
    this.sandbox = sandbox;
    this.mounts = buildSandboxFsMounts(sandbox);
    const mountsByContainer = [...this.mounts].toSorted(
      (a, b) => b.containerRoot.length - a.containerRoot.length,
    );
    this.pathGuard = new SandboxFsPathGuard({
      mountsByContainer,
      runCommand: (script, options) => this.runCommand(script, options),
    });
  }

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveResolvedPath(params);
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
    const target = this.resolveResolvedPath(params);
    return this.readPinnedFile(target);
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "write files");
    const writeCheck = {
      options: { action: "write files", requireWritable: true } as const,
      target,
    };
    await this.pathGuard.assertPathSafety(target, writeCheck.options);
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const pinnedWriteTarget = await this.pathGuard.resolveAnchoredPinnedEntry(
      target,
      "write files",
    );
    await this.runCheckedCommand({
      ...buildPinnedWritePlan({
        check: writeCheck,
        mkdir: params.mkdir !== false,
        pinned: pinnedWriteTarget,
      }),
      signal: params.signal,
      stdin: buffer,
    });
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "create directories");
    const mkdirCheck = {
      options: {
        action: "create directories",
        allowedType: "directory",
        requireWritable: true,
      } as const,
      target,
    };
    await this.runCheckedCommand({
      ...buildPinnedMkdirpPlan({
        check: mkdirCheck,
        pinned: this.pathGuard.resolvePinnedDirectoryEntry(target, "create directories"),
      }),
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
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "remove files");
    const removeCheck = {
      options: {
        action: "remove files",
        requireWritable: true,
      } as const,
      target,
    };
    await this.runCheckedCommand({
      ...buildPinnedRemovePlan({
        check: removeCheck,
        force: params.force,
        pinned: this.pathGuard.resolvePinnedEntry(target, "remove files"),
        recursive: params.recursive,
      }),
      signal: params.signal,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = this.resolveResolvedPath({ cwd: params.cwd, filePath: params.from });
    const to = this.resolveResolvedPath({ cwd: params.cwd, filePath: params.to });
    this.ensureWriteAccess(from, "rename files");
    this.ensureWriteAccess(to, "rename files");
    const fromCheck = {
      options: {
        action: "rename files",
        requireWritable: true,
      } as const,
      target: from,
    };
    const toCheck = {
      options: {
        action: "rename files",
        requireWritable: true,
      } as const,
      target: to,
    };
    await this.runCheckedCommand({
      ...buildPinnedRenamePlan({
        from: this.pathGuard.resolvePinnedEntry(from, "rename files"),
        fromCheck,
        to: this.pathGuard.resolvePinnedEntry(to, "rename files"),
        toCheck,
      }),
      signal: params.signal,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target, "stat files");
    const result = await this.runPlannedCommand(
      buildStatPlan(target, anchoredTarget),
      params.signal,
    );
    if (result.code !== 0) {
      const stderr = result.stderr.toString("utf8");
      if (stderr.includes("No such file or directory")) {
        return null;
      }
      const message = stderr.trim() || `stat failed with code ${result.code}`;
      throw new Error(`stat failed for ${target.containerPath}: ${message}`);
    }
    const text = result.stdout.toString("utf8").trim();
    const [typeRaw, sizeRaw, mtimeRaw] = text.split("|");
    const size = Number.parseInt(sizeRaw ?? "0", 10);
    const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1000;
    return {
      mtimeMs: Number.isFinite(mtime) ? mtime : 0,
      size: Number.isFinite(size) ? size : 0,
      type: coerceStatType(typeRaw),
    };
  }

  private async runCommand(
    script: string,
    options: RunCommandOptions = {},
  ): Promise<SandboxBackendCommandResult> {
    const { backend } = this.sandbox;
    if (backend) {
      return await backend.runShellCommand({
        allowFailure: options.allowFailure,
        args: options.args,
        script,
        signal: options.signal,
        stdin: options.stdin,
      });
    }
    return await runDockerSandboxShellCommand({
      allowFailure: options.allowFailure,
      args: options.args,
      containerName: this.sandbox.containerName,
      script,
      signal: options.signal,
      stdin: options.stdin,
    });
  }

  private async readPinnedFile(target: SandboxResolvedFsPath): Promise<Buffer> {
    const opened = await this.pathGuard.openReadableFile(target);
    try {
      return fs.readFileSync(opened.fd);
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  private async runCheckedCommand(
    plan: SandboxFsCommandPlan & { stdin?: Buffer | string; signal?: AbortSignal },
  ): Promise<SandboxBackendCommandResult> {
    await this.pathGuard.assertPathChecks(plan.checks);
    if (plan.recheckBeforeCommand) {
      await this.pathGuard.assertPathChecks(plan.checks);
    }
    return await this.runCommand(plan.script, {
      allowFailure: plan.allowFailure,
      args: plan.args,
      signal: plan.signal,
      stdin: plan.stdin,
    });
  }

  private async runPlannedCommand(
    plan: SandboxFsCommandPlan,
    signal?: AbortSignal,
  ): Promise<SandboxBackendCommandResult> {
    return await this.runCheckedCommand({ ...plan, signal });
  }

  private ensureWriteAccess(target: SandboxResolvedFsPath, action: string) {
    if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private resolveResolvedPath(params: { filePath: string; cwd?: string }): SandboxResolvedFsPath {
    return resolveSandboxFsPathWithMounts({
      cwd: params.cwd ?? this.sandbox.workspaceDir,
      defaultContainerRoot: this.sandbox.containerWorkdir,
      defaultWorkspaceRoot: this.sandbox.workspaceDir,
      filePath: params.filePath,
      mounts: this.mounts,
    });
  }
}

function allowsWrites(access: SandboxWorkspaceAccess): boolean {
  return access === "rw";
}

function coerceStatType(typeRaw?: string): "file" | "directory" | "other" {
  if (!typeRaw) {
    return "other";
  }
  const normalized = normalizeOptionalLowercaseString(typeRaw) ?? "";
  if (normalized.includes("directory")) {
    return "directory";
  }
  if (normalized.includes("file")) {
    return "file";
  }
  return "other";
}
