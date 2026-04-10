import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readMemoryFile } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let memoryDir: string;
  let extraDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-read-"));
    memoryDir = path.join(workspaceDir, "memory");
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(
      [memoryDir, extraDir].map(async (root) => {
        const entries = await fs.readdir(root).catch(() => []);
        await Promise.all(
          entries.map(async (entry) => {
            await fs.rm(path.join(root, entry), { force: true, recursive: true });
          }),
        );
      }),
    );
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { force: true, recursive: true });
  });

  it("returns empty text when the requested file does not exist", async () => {
    const relPath = "memory/2099-01-01.md";
    const result = await readMemoryFile({
      extraPaths: [],
      relPath,
      workspaceDir,
    });
    expect(result).toEqual({ path: relPath, text: "" });
  });

  it("returns content slices when the file exists", async () => {
    const relPath = "memory/2026-02-20.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["line 1", "line 2", "line 3"].join("\n"), "utf8");

    const result = await readMemoryFile({
      extraPaths: [],
      from: 2,
      lines: 1,
      relPath,
      workspaceDir,
    });
    expect(result).toEqual({ path: relPath, text: "line 2" });
  });

  it("returns empty text when the requested slice is past EOF", async () => {
    const relPath = "memory/window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["alpha", "beta"].join("\n"), "utf8");

    const result = await readMemoryFile({
      extraPaths: [],
      from: 10,
      lines: 5,
      relPath,
      workspaceDir,
    });
    expect(result).toEqual({ path: relPath, text: "" });
  });

  it("returns empty text when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "first\nsecond", "utf8");

    const realReadFile = fs.readFile;
    let injected = false;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        const [target, options] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realReadFile(target, options);
      });

    try {
      const result = await readMemoryFile({
        extraPaths: [],
        relPath,
        workspaceDir,
      });
      expect(result).toEqual({ path: relPath, text: "" });
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects non-memory paths", async () => {
    await expect(
      readMemoryFile({
        extraPaths: [],
        relPath: "NOTES.md",
        workspaceDir,
      }),
    ).rejects.toThrow("path required");
  });

  it("allows additional memory paths and blocks symlinks", async () => {
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    await expect(
      readMemoryFile({
        extraPaths: [extraDir],
        relPath: "extra/extra.md",
        workspaceDir,
      }),
    ).resolves.toEqual({
      path: "extra/extra.md",
      text: "Extra content.",
    });

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (error) {
      const {code} = (error as NodeJS.ErrnoException);
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw error;
      }
    }
    if (symlinkOk) {
      await expect(
        readMemoryFile({
          extraPaths: [extraDir],
          relPath: "extra/linked.md",
          workspaceDir,
        }),
      ).rejects.toThrow("path required");
    }
  });
});
