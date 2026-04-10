import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { assertNoPathAliasEscape } from "./path-alias-guards.js";

async function withAliasRoot(cb: (root: string) => Promise<void>): Promise<void> {
  await withTempDir(
    { parentDir: process.cwd(), prefix: "openclaw-path-alias-", subdir: "root" },
    cb,
  );
}

describe("assertNoPathAliasEscape", () => {
  it.runIf(process.platform !== "win32").each([
    {
      name: "rejects broken final symlink targets outside root",
      rejects: true,
      setup: async (root: string) => {
        const outside = path.join(path.dirname(root), "outside");
        await fs.mkdir(outside, { recursive: true });
        const linkPath = path.join(root, "jump");
        await fs.symlink(path.join(outside, "owned.txt"), linkPath);
        return linkPath;
      },
    },
    {
      name: "allows broken final symlink targets that remain inside root",
      rejects: false,
      setup: async (root: string) => {
        const linkPath = path.join(root, "jump");
        await fs.symlink(path.join(root, "missing", "owned.txt"), linkPath);
        return linkPath;
      },
    },
    {
      name: "rejects broken targets that traverse via an in-root symlink alias",
      rejects: true,
      setup: async (root: string) => {
        const outside = path.join(path.dirname(root), "outside");
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(root, "hop"));
        const linkPath = path.join(root, "jump");
        await fs.symlink(path.join("hop", "missing", "owned.txt"), linkPath);
        return linkPath;
      },
    },
  ])("$name", async ({ setup, rejects }) => {
    await withAliasRoot(async (root) => {
      const absolutePath = await setup(root);
      const promise = assertNoPathAliasEscape({
        absolutePath,
        boundaryLabel: "sandbox root",
        rootPath: root,
      });
      if (rejects) {
        await expect(promise).rejects.toThrow(/Symlink escapes sandbox root/);
        return;
      }
      await expect(promise).resolves.toBeUndefined();
    });
  });
});
