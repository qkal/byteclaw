import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;

function trySetSecureMode(pathname: string) {
  try {
    fs.chmodSync(pathname, JSON_FILE_MODE);
  } catch {
    // Best-effort on platforms without chmod support
  }
}

function trySyncDirectory(pathname: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.dirname(pathname), "r");
    fs.fsyncSync(fd);
  } catch {
    // Best-effort; some platforms/filesystems do not support syncing directories.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

function readSymlinkTargetPath(linkPath: string): string {
  const target = fs.readlinkSync(linkPath);
  return path.resolve(path.dirname(linkPath), target);
}

function resolveJsonWriteTarget(pathname: string): { targetPath: string; followsSymlink: boolean } {
  let currentPath = pathname;
  const visited = new Set<string>();
  let followsSymlink = false;

  for (;;) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return { followsSymlink, targetPath: currentPath };
    }

    if (!stat.isSymbolicLink()) {
      return { followsSymlink, targetPath: currentPath };
    }

    if (visited.has(currentPath)) {
      const err = new Error(
        `Too many symlink levels while resolving ${pathname}`,
      ) as NodeJS.ErrnoException;
      err.code = "ELOOP";
      throw err;
    }

    visited.add(currentPath);
    followsSymlink = true;
    currentPath = readSymlinkTargetPath(currentPath);
  }
}

function renameJsonFileWithFallback(tmpPath: string, pathname: string) {
  try {
    fs.renameSync(tmpPath, pathname);
    return;
  } catch (error) {
    const {code} = (error as NodeJS.ErrnoException);
    // Windows does not reliably support rename-based overwrite for existing files.
    if (code === "EPERM" || code === "EEXIST") {
      fs.copyFileSync(tmpPath, pathname);
      fs.rmSync(tmpPath, { force: true });
      return;
    }
    throw error;
  }
}

function writeTempJsonFile(pathname: string, payload: string) {
  const fd = fs.openSync(pathname, "w", JSON_FILE_MODE);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function loadJsonFile<T = unknown>(pathname: string): T | undefined {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const { targetPath, followsSymlink } = resolveJsonWriteTarget(pathname);
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  if (!followsSymlink) {
    fs.mkdirSync(path.dirname(targetPath), { mode: JSON_DIR_MODE, recursive: true });
  }
  try {
    writeTempJsonFile(tmpPath, payload);
    trySetSecureMode(tmpPath);
    renameJsonFileWithFallback(tmpPath, targetPath);
    trySetSecureMode(targetPath);
    trySyncDirectory(targetPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup when rename does not happen
    }
  }
}
