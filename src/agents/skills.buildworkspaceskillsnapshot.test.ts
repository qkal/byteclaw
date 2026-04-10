import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt } from "./skills.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-snapshot-suite-");
let truncationWorkspaceTemplateDir = "";
let nestedRepoTemplateDir = "";

beforeAll(async () => {
  await fixtureSuite.setup();
  truncationWorkspaceTemplateDir = await fixtureSuite.createCaseDir(
    "template-truncation-workspace",
  );
  for (let i = 0; i < 8; i += 1) {
    const name = `skill-${String(i).padStart(2, "0")}`;
    await writeSkill({
      description: "x".repeat(800),
      dir: path.join(truncationWorkspaceTemplateDir, "skills", name),
      name,
    });
  }

  nestedRepoTemplateDir = await fixtureSuite.createCaseDir("template-skills-repo");
  for (let i = 0; i < 8; i += 1) {
    const name = `repo-skill-${String(i).padStart(2, "0")}`;
    await writeSkill({
      description: `Desc ${i}`,
      dir: path.join(nestedRepoTemplateDir, "skills", name),
      name,
    });
  }
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withEnv({ HOME: workspaceDir, PATH: "" }, cb);
}

function buildSnapshot(
  workspaceDir: string,
  options?: Parameters<typeof buildWorkspaceSkillSnapshot>[1],
) {
  return withWorkspaceHome(workspaceDir, () =>
    buildWorkspaceSkillSnapshot(workspaceDir, {
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      ...options,
    }),
  );
}

async function cloneTemplateDir(templateDir: string, prefix: string): Promise<string> {
  const cloned = await fixtureSuite.createCaseDir(prefix);
  await fs.cp(templateDir, cloned, { recursive: true });
  return cloned;
}

function expectSnapshotNamesAndPrompt(
  snapshot: ReturnType<typeof buildWorkspaceSkillSnapshot>,
  params: { contains?: string[]; omits?: string[] },
) {
  for (const name of params.contains ?? []) {
    expect(snapshot.skills.map((skill) => skill.name)).toContain(name);
    expect(snapshot.prompt).toContain(name);
  }
  for (const name of params.omits ?? []) {
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain(name);
    expect(snapshot.prompt).not.toContain(name);
  }
}

describe("buildWorkspaceSkillSnapshot", () => {
  it("returns an empty snapshot when skills dirs are missing", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");

    const snapshot = buildSnapshot(workspaceDir);

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toEqual([]);
  });

  it("omits disable-model-invocation skills from the prompt", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      description: "Visible skill",
      dir: path.join(workspaceDir, "skills", "visible-skill"),
      name: "visible-skill",
    });
    await writeSkill({
      description: "Hidden skill",
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      frontmatterExtra: "disable-model-invocation: true",
      name: "hidden-skill",
    });

    const snapshot = buildSnapshot(workspaceDir);

    expect(snapshot.prompt).toContain("visible-skill");
    expect(snapshot.prompt).not.toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("visible-skill");
  });

  it("keeps prompt output aligned with buildWorkspaceSkillsPrompt", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      description: "Visible",
      dir: path.join(workspaceDir, "skills", "visible"),
      name: "visible",
    });
    await writeSkill({
      description: "Hidden",
      dir: path.join(workspaceDir, "skills", "hidden"),
      frontmatterExtra: "disable-model-invocation: true",
      name: "hidden",
    });
    const config = {
      skills: {
        limits: {
          maxSkillsInPrompt: 1,
          maxSkillsPromptChars: 200,
        },
      },
    } as const;
    const opts = {
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      config,
      eligibility: {
        remote: {
          hasAnyBin: (_bins: string[]) => true,
          hasBin: (_bin: string) => true,
          note: "Remote note",
          platforms: ["linux"],
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    };

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, opts),
    );
    const prompt = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, opts),
    );

    expect(snapshot.prompt).toBe(prompt);
  });

  it("truncates the skills prompt when it exceeds the configured char budget", async () => {
    const workspaceDir = await cloneTemplateDir(truncationWorkspaceTemplateDir, "workspace");

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        config: {
          skills: {
            limits: {
              maxSkillsInPrompt: 100,
              maxSkillsPromptChars: 500,
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      }),
    );

    expect(snapshot.prompt).toContain("⚠️ Skills truncated");
    expect(snapshot.prompt.length).toBeLessThan(2000);
  });

  it("uses agents.list[].skills as a full replacement for inherited defaults", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
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
    await writeSkill({
      description: "Docs",
      dir: path.join(workspaceDir, "skills", "docs-search"),
      name: "docs-search",
    });

    const snapshot = buildSnapshot(workspaceDir, {
      agentId: "writer",
      config: {
        agents: {
          defaults: {
            skills: ["github", "weather"],
          },
          list: [{ id: "writer", skills: ["docs-search", "github"] }],
        },
      },
    });

    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "docs-search",
      "github",
    ]);
    expect(snapshot.skillFilter).toEqual(["docs-search", "github"]);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const repoDir = await cloneTemplateDir(nestedRepoTemplateDir, "skills-repo");

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        config: {
          skills: {
            limits: {
              maxCandidatesPerRoot: 5,
              maxSkillsLoadedPerSource: 5,
            },
            load: {
              extraDirs: [repoDir],
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      }),
    );

    // We should only have loaded a small subset.
    expect(snapshot.skills.length).toBeLessThanOrEqual(5);
    expect(snapshot.prompt).toContain("repo-skill-00");
    expect(snapshot.prompt).not.toContain("repo-skill-07");
  });

  it("skips skills whose SKILL.md exceeds maxSkillFileBytes", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");

    await writeSkill({
      description: "Small",
      dir: path.join(workspaceDir, "skills", "small-skill"),
      name: "small-skill",
    });

    await writeSkill({
      body: "x".repeat(5000),
      description: "Big",
      dir: path.join(workspaceDir, "skills", "big-skill"),
      name: "big-skill",
    });

    const snapshot = buildSnapshot(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxSkillFileBytes: 1000,
          },
        },
      },
    });

    expectSnapshotNamesAndPrompt(snapshot, {
      contains: ["small-skill"],
      omits: ["big-skill"],
    });
  });

  it("detects nested skills roots beyond the first 25 entries", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const repoDir = await fixtureSuite.createCaseDir("skills-repo");

    // Create 30 nested dirs, but only the last one is an actual skill.
    for (let i = 0; i < 30; i += 1) {
      await fs.mkdir(path.join(repoDir, "skills", `entry-${String(i).padStart(2, "0")}`), {
        recursive: true,
      });
    }

    await writeSkill({
      description: "Nested skill discovered late",
      dir: path.join(repoDir, "skills", "entry-29"),
      name: "late-skill",
    });

    const snapshot = buildSnapshot(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 30,
            maxSkillsLoadedPerSource: 30,
          },
          load: {
            extraDirs: [repoDir],
          },
        },
      },
    });

    expectSnapshotNamesAndPrompt(snapshot, {
      contains: ["late-skill"],
    });
  });

  it("enforces maxSkillFileBytes for root-level SKILL.md", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const rootSkillDir = await fixtureSuite.createCaseDir("root-skill");

    await writeSkill({
      body: "x".repeat(5000),
      description: "Big",
      dir: rootSkillDir,
      name: "root-big-skill",
    });

    const snapshot = buildSnapshot(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxSkillFileBytes: 1000,
          },
          load: {
            extraDirs: [rootSkillDir],
          },
        },
      },
    });

    expectSnapshotNamesAndPrompt(snapshot, {
      omits: ["root-big-skill"],
    });
  });
});
