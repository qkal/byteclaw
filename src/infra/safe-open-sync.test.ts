import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { openVerifiedFileSync } from "./safe-open-sync.js";

type SafeOpenSyncFs = NonNullable<Parameters<typeof openVerifiedFileSync>[0]["ioFs"]>;
type SafeOpenSyncLstatSync = SafeOpenSyncFs["lstatSync"];
type SafeOpenSyncRealpathSync = SafeOpenSyncFs["realpathSync"];
type SafeOpenSyncFstatSync = SafeOpenSyncFs["fstatSync"];

function mockStat(params: {
  isFile?: boolean;
  isDirectory?: boolean;
  nlink?: number;
  size?: number;
  dev?: number;
  ino?: number;
}): fs.Stats {
  return {
    dev: params.dev ?? 1,
    ino: params.ino ?? 1,
    isDirectory: () => params.isDirectory ?? false,
    isFile: () => params.isFile ?? false,
    isSymbolicLink: () => false,
    nlink: params.nlink ?? 1,
    size: params.size ?? 0,
  } as unknown as fs.Stats;
}

function mockRealpathSync(result: string): SafeOpenSyncRealpathSync {
  const resolvePath = ((_: fs.PathLike) => result) as SafeOpenSyncRealpathSync;
  resolvePath.native = ((_: fs.PathLike) => result) as typeof resolvePath.native;
  return resolvePath;
}

function mockLstatSync(read: (filePath: fs.PathLike) => fs.Stats): SafeOpenSyncLstatSync {
  return ((filePath: fs.PathLike) => read(filePath)) as unknown as SafeOpenSyncLstatSync;
}

function mockFstatSync(stat: fs.Stats): SafeOpenSyncFstatSync {
  return ((_: number) => stat) as unknown as SafeOpenSyncFstatSync;
}

async function expectOpenFailure(params: {
  setup: (root: string) => Promise<Parameters<typeof openVerifiedFileSync>[0]>;
  expectedReason: "path" | "validation" | "io";
}): Promise<void> {
  await withTempDir({ prefix: "openclaw-safe-open-" }, async (root) => {
    const opened = openVerifiedFileSync(await params.setup(root));
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.reason).toBe(params.expectedReason);
    }
  });
}

function expectOpenReason(
  opened: ReturnType<typeof openVerifiedFileSync>,
  expectedReason: "path" | "validation" | "io",
): void {
  expect(opened.ok).toBe(false);
  if (opened.ok) {
    return;
  }
  expect(opened.reason).toBe(expectedReason);
}

describe("openVerifiedFileSync", () => {
  it.each([
    {
      expectedReason: "path" as const,
      name: "missing files",
      setup: async (root: string) => ({ filePath: path.join(root, "missing.txt") }),
    },
    {
      expectedReason: "validation" as const,
      name: "directories by default",
      setup: async (root: string) => {
        const targetDir = path.join(root, "nested");
        await fsp.mkdir(targetDir, { recursive: true });
        return { filePath: targetDir };
      },
    },
    {
      expectedReason: "validation" as const,
      name: "symlink paths when rejectPathSymlink is enabled",
      setup: async (root: string) => {
        const targetFile = path.join(root, "target.txt");
        const linkFile = path.join(root, "link.txt");
        await fsp.writeFile(targetFile, "hello");
        await fsp.symlink(targetFile, linkFile);
        return {
          filePath: linkFile,
          rejectPathSymlink: true,
        };
      },
    },
    {
      expectedReason: "validation" as const,
      name: "files larger than maxBytes",
      setup: async (root: string) => {
        const filePath = path.join(root, "payload.txt");
        await fsp.writeFile(filePath, "hello");
        return {
          filePath,
          maxBytes: 4,
        };
      },
    },
  ])("fails for $name", async ({ setup, expectedReason }) => {
    await expectOpenFailure({ expectedReason, setup });
  });

  it("accepts directories when allowedType is directory", async () => {
    await withTempDir({ prefix: "openclaw-safe-open-" }, async (root) => {
      const targetDir = path.join(root, "nested");
      await fsp.mkdir(targetDir, { recursive: true });

      const opened = openVerifiedFileSync({
        allowedType: "directory",
        filePath: targetDir,
        rejectHardlinks: true,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) {
        return;
      }
      expect(opened.stat.isDirectory()).toBe(true);
      fs.closeSync(opened.fd);
    });
  });

  it("rejects post-open validation mismatches and closes the fd", () => {
    const closeSync = (fd: number) => {
      closed.push(fd);
    };
    const closed: number[] = [];
    const ioFs: SafeOpenSyncFs = {
      closeSync,
      constants: fs.constants,
      fstatSync: mockFstatSync(mockStat({ dev: 2, ino: 1, isFile: true, size: 1 })),
      lstatSync: mockLstatSync((filePath) =>
        String(filePath) === "/real/file.txt"
          ? mockStat({ dev: 1, ino: 1, isFile: true, size: 1 })
          : mockStat({ isFile: false }),
      ),
      openSync: () => 42,
      realpathSync: mockRealpathSync("/real/file.txt"),
    };

    const opened = openVerifiedFileSync({
      filePath: "/input/file.txt",
      ioFs,
    });
    expectOpenReason(opened, "validation");
    expect(closed).toEqual([42]);
  });

  it("reports non-path filesystem failures as io errors", () => {
    const ioFs: SafeOpenSyncFs = {
      closeSync: () => {},
      constants: fs.constants,
      fstatSync: mockFstatSync(mockStat({ isFile: true })),
      lstatSync: () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      openSync: () => 42,
      realpathSync: mockRealpathSync("/real/file.txt"),
    };

    const opened = openVerifiedFileSync({
      filePath: "/input/file.txt",
      ioFs,
      rejectPathSymlink: true,
    });
    expectOpenReason(opened, "io");
  });
});
