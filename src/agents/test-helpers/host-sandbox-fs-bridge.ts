import fs from "node:fs/promises";
import path from "node:path";
import { resolveSandboxPath } from "../sandbox-paths.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "../sandbox/fs-bridge.js";

export function createSandboxFsBridgeFromResolver(
  resolvePath: (filePath: string, cwd?: string) => SandboxResolvedPath,
): SandboxFsBridge {
  return {
    mkdirp: async ({ filePath, cwd }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      await fs.mkdir(target.hostPath, { recursive: true });
    },
    readFile: async ({ filePath, cwd }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      return fs.readFile(target.hostPath);
    },
    remove: async ({ filePath, cwd, recursive, force }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      await fs.rm(target.hostPath, {
        force: force ?? false,
        recursive: recursive ?? false,
      });
    },
    rename: async ({ from, to, cwd }) => {
      const source = resolvePath(from, cwd);
      const target = resolvePath(to, cwd);
      if (!source.hostPath || !target.hostPath) {
        throw new Error(
          `Expected hostPath for rename: ${source.containerPath} -> ${target.containerPath}`,
        );
      }
      await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
      await fs.rename(source.hostPath, target.hostPath);
    },
    resolvePath: ({ filePath, cwd }) => resolvePath(filePath, cwd),
    stat: async ({ filePath, cwd }) => {
      try {
        const target = resolvePath(filePath, cwd);
        if (!target.hostPath) {
          throw new Error(`Expected hostPath for ${target.containerPath}`);
        }
        const stats = await fs.stat(target.hostPath);
        return {
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        } satisfies SandboxFsStat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    writeFile: async ({ filePath, cwd, data, mkdir = true }) => {
      const target = resolvePath(filePath, cwd);
      if (!target.hostPath) {
        throw new Error(`Expected hostPath for ${target.containerPath}`);
      }
      if (mkdir) {
        await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await fs.writeFile(target.hostPath, buffer);
    },
  };
}

export function createHostSandboxFsBridge(rootDir: string): SandboxFsBridge {
  const root = path.resolve(rootDir);

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
    const resolved = resolveSandboxPath({
      cwd: cwd ?? root,
      filePath,
      root,
    });
    const relativePath = resolved.relative
      ? resolved.relative.split(path.sep).filter(Boolean).join(path.posix.sep)
      : "";
    const containerPath = relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
    return {
      containerPath,
      hostPath: resolved.resolved,
      relativePath,
    };
  };

  return createSandboxFsBridgeFromResolver(resolvePath);
}
