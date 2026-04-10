import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { findGitRoot, resolveGitHeadPath } from "./git-root.js";

async function expectGitRootResolution(params: {
  label: string;
  setup: (
    temp: string,
  ) => Promise<{ startPath: string; expectedRoot: string | null; expectedHead: string | null }>;
}): Promise<void> {
  await withTempDir({ prefix: `openclaw-${params.label}-` }, async (temp) => {
    const { startPath, expectedRoot, expectedHead } = await params.setup(temp);
    expect(findGitRoot(startPath)).toBe(expectedRoot);
    expect(resolveGitHeadPath(startPath)).toBe(expectedHead);
  });
}

describe("git-root", () => {
  it.each([
    {
      label: "git-root-self",
      name: "starting at the repo root itself",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        return {
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
          expectedRoot: repoRoot,
          startPath: repoRoot,
        };
      },
    },
    {
      label: "git-root-dir",
      name: ".git is a directory",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        await fs.mkdir(workspace, { recursive: true });
        return {
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
          expectedRoot: repoRoot,
          startPath: workspace,
        };
      },
    },
    {
      label: "git-root-file",
      name: ".git is a gitdir pointer file",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        const gitDir = path.join(repoRoot, ".actual-git");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .actual-git\n", "utf8");
        return {
          expectedHead: path.join(gitDir, "HEAD"),
          expectedRoot: repoRoot,
          startPath: workspace,
        };
      },
    },
    {
      label: "git-root-invalid-file",
      name: "invalid gitdir content still keeps root detection",
      setup: async (temp: string) => {
        const parentRoot = path.join(temp, "repo");
        const childRoot = path.join(parentRoot, "child");
        const nested = path.join(childRoot, "nested");
        await fs.mkdir(path.join(parentRoot, ".git"), { recursive: true });
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(childRoot, ".git"), "not-a-gitdir-pointer\n", "utf8");
        return {
          expectedHead: path.join(parentRoot, ".git", "HEAD"),
          expectedRoot: childRoot,
          startPath: nested,
        };
      },
    },
    {
      label: "git-root-invalid-only",
      name: "invalid gitdir content without a parent repo",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const nested = path.join(repoRoot, "nested");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "not-a-gitdir-pointer\n", "utf8");
        return {
          expectedHead: null,
          expectedRoot: repoRoot,
          startPath: nested,
        };
      },
    },
  ])("resolves git roots when $name", async ({ label, setup }) => {
    await expectGitRootResolution({ label, setup });
  });

  it("respects maxDepth traversal limit", async () => {
    await withTempDir({ prefix: "openclaw-git-root-depth-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const nested = path.join(repoRoot, "a", "b", "c");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });

      expect(findGitRoot(nested, { maxDepth: 2 })).toBeNull();
      expect(resolveGitHeadPath(nested, { maxDepth: 2 })).toBeNull();
    });
  });
});
