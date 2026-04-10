import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./skills.js";
import { readSkillFrontmatterSafe } from "./skills/local-loader.js";
import { writePluginWithSkill } from "./test-helpers/skill-plugin-fixtures.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

async function setupWorkspaceWithProsePlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "open-prose");

  await writePluginWithSkill({
    pluginId: "open-prose",
    pluginRoot,
    skillDescription: "test",
    skillId: "prose",
  });

  return { bundledDir, managedDir, workspaceDir };
}

async function setupWorkspaceWithDiffsPlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "diffs");

  await writePluginWithSkill({
    pluginId: "diffs",
    pluginRoot,
    skillDescription: "test",
    skillId: "diffs",
  });

  return { bundledDir, managedDir, workspaceDir };
}

describe("loadWorkspaceSkillEntries", () => {
  it("handles an empty managed skills dir without throwing", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    await fs.mkdir(managedDir, { recursive: true });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      managedSkillsDir: managedDir,
    });

    expect(entries).toEqual([]);
  });

  it("includes plugin-shipped skills when the plugin is enabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithProsePlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: bundledDir,
      config: {
        plugins: {
          entries: { "open-prose": { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("prose");
  });

  it("excludes plugin-shipped skills when the plugin is not allowed", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithProsePlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: bundledDir,
      config: {
        plugins: {
          allow: ["something-else"],
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("prose");
  });

  it("includes diffs plugin skill when the plugin is enabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithDiffsPlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: bundledDir,
      config: {
        plugins: {
          entries: { diffs: { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("diffs");
  });

  it("excludes diffs plugin skill when the plugin is disabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithDiffsPlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: bundledDir,
      config: {
        plugins: {
          entries: { diffs: { enabled: false } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("diffs");
  });

  it("falls back to the skill directory name when frontmatter omits name", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "fallback-name");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "description: Skill without explicit name", "---", "", "# Fallback"].join("\n"),
      "utf8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("fallback-name");
  });

  it("marks disable-model-invocation skills as hidden in exposure metadata for newly loaded entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      description: "Hidden prompt entry",
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      frontmatterExtra: "disable-model-invocation: true",
      name: "hidden-skill",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    const hiddenEntry = entries.find((entry) => entry.skill.name === "hidden-skill");

    expect(hiddenEntry?.invocation?.disableModelInvocation).toBe(true);
    expect(hiddenEntry?.exposure?.includeInAvailableSkillsPrompt).toBe(false);
  });

  it("inherits agents.defaults.skills when an agent omits skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      description: "GitHub",
      dir: path.join(workspaceDir, "skills", "github"),
      name: "github",
    });
    await writeSkill({
      description: "Weather",
      dir: path.join(workspaceDir, "skills", "weather"),
      name: "weather",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      agentId: "writer",
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["github"]);
  });

  it("uses agents.list[].skills as a full replacement for defaults", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      description: "GitHub",
      dir: path.join(workspaceDir, "skills", "github"),
      name: "github",
    });
    await writeSkill({
      description: "Docs",
      dir: path.join(workspaceDir, "skills", "docs-search"),
      name: "docs-search",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      agentId: "writer",
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["docs-search"]);
  });

  it("keeps remote-eligible skills when agent filtering is active", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      description: "Needs a remote bin",
      dir: path.join(workspaceDir, "skills", "remote-only"),
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
      name: "remote-only",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      agentId: "writer",
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config: {
        agents: {
          defaults: {
            skills: ["remote-only"],
          },
          list: [{ id: "writer" }],
        },
      },
      eligibility: {
        remote: {
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          hasBin: () => false,
          note: "sandbox",
          platforms: ["linux"],
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["remote-only"]);
  });

  it.runIf(process.platform !== "win32")(
    "skips workspace skill directories that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      const escapedSkillDir = path.join(outsideDir, "outside-skill");
      await writeSkill({
        description: "Outside",
        dir: escapedSkillDir,
        name: "outside-skill",
      });
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      await fs.symlink(escapedSkillDir, path.join(workspaceDir, "skills", "escaped-skill"), "dir");

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips workspace skill files that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      await writeSkill({
        description: "Outside file",
        dir: outsideDir,
        name: "outside-file-skill",
      });
      const skillDir = path.join(workspaceDir, "skills", "escaped-file");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(skillDir, "SKILL.md"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips symlinked SKILL.md even when the target stays inside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const targetDir = path.join(workspaceDir, "safe-target");
      await writeSkill({
        description: "Target skill",
        dir: targetDir,
        name: "symlink-target",
      });

      const skillDir = path.join(workspaceDir, "skills", "symlinked");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.symlink(path.join(targetDir, "SKILL.md"), path.join(skillDir, "SKILL.md"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads skill frontmatter when the allowed root is the filesystem root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillDir = path.join(workspaceDir, "skills", "root-allowed");
      await writeSkill({
        description: "Readable from filesystem root",
        dir: skillDir,
        name: "root-allowed",
      });

      const frontmatter = readSkillFrontmatterSafe({
        filePath: path.join(skillDir, "SKILL.md"),
        rootDir: path.parse(skillDir).root,
      });

      expect(frontmatter).toMatchObject({
        description: "Readable from filesystem root",
        name: "root-allowed",
      });
    },
  );
});
