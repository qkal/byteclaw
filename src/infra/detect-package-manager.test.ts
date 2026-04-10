import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { detectPackageManager } from "./detect-package-manager.js";

async function withPackageManagerRoot<T>(
  files: { path: string; content: string }[],
  run: (root: string) => Promise<T>,
): Promise<T> {
  return await withTempDir({ prefix: "openclaw-detect-pm-" }, async (root) => {
    for (const file of files) {
      await fs.writeFile(path.join(root, file.path), file.content, "utf8");
    }
    return await run(root);
  });
}

describe("detectPackageManager", () => {
  it("prefers packageManager from package.json when supported", async () => {
    await withPackageManagerRoot(
      [
        { content: JSON.stringify({ packageManager: "pnpm@10.8.1" }), path: "package.json" },
        { content: "", path: "package-lock.json" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("pnpm");
      },
    );
  });

  it.each([
    {
      expected: "bun",
      files: [{ content: "", path: "bun.lock" }],
      name: "uses bun.lock",
    },
    {
      expected: "bun",
      files: [{ content: "", path: "bun.lockb" }],
      name: "uses bun.lockb",
    },
    {
      expected: "npm",
      files: [
        { content: JSON.stringify({ packageManager: "yarn@4.0.0" }), path: "package.json" },
        { content: "", path: "package-lock.json" },
      ],
      name: "falls back to npm lockfiles for unsupported packageManager values",
    },
  ])("falls back to lockfiles when $name", async ({ files, expected }) => {
    await withPackageManagerRoot(files, async (root) => {
      await expect(detectPackageManager(root)).resolves.toBe(expected);
    });
  });

  it("returns null when no package manager markers exist", async () => {
    await withPackageManagerRoot(
      [{ content: "{not-json}", path: "package.json" }],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBeNull();
      },
    );
  });
});
