import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt, syncSkillsToWorkspace } from "./skills.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let fixtureRoot = "";
let fixtureCount = 0;
let syncSourceTemplateDir = "";

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function syncSourceSkillsToTarget(sourceWorkspace: string, targetWorkspace: string) {
  await withEnv({ HOME: sourceWorkspace, PATH: "" }, () =>
    syncSkillsToWorkspace({
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
    }),
  );
}

async function expectSyncedSkillConfinement(params: {
  sourceWorkspace: string;
  targetWorkspace: string;
  safeSkillDirName: string;
  escapedDest: string;
}) {
  expect(await pathExists(params.escapedDest)).toBe(false);
  await syncSourceSkillsToTarget(params.sourceWorkspace, params.targetWorkspace);
  expect(
    await pathExists(
      path.join(params.targetWorkspace, "skills", params.safeSkillDirName, "SKILL.md"),
    ),
  ).toBe(true);
  expect(await pathExists(params.escapedDest)).toBe(false);
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-sync-suite-"));
  syncSourceTemplateDir = await createCaseDir("source-template");
  await writeSkill({
    description: "Extra version",
    dir: path.join(syncSourceTemplateDir, ".extra", "demo-skill"),
    name: "demo-skill",
  });
  await writeSkill({
    description: "Bundled version",
    dir: path.join(syncSourceTemplateDir, ".bundled", "demo-skill"),
    name: "demo-skill",
  });
  await writeSkill({
    description: "Managed version",
    dir: path.join(syncSourceTemplateDir, ".managed", "demo-skill"),
    name: "demo-skill",
  });
  await writeSkill({
    description: "Workspace version",
    dir: path.join(syncSourceTemplateDir, "skills", "demo-skill"),
    name: "demo-skill",
  });
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { force: true, recursive: true });
});

describe("buildWorkspaceSkillsPrompt", () => {
  const buildPrompt = (
    workspaceDir: string,
    opts?: Parameters<typeof buildWorkspaceSkillsPrompt>[1],
  ) =>
    withEnv({ HOME: workspaceDir, PATH: "" }, () => buildWorkspaceSkillsPrompt(workspaceDir, opts));

  const cloneSourceTemplate = async () => {
    const sourceWorkspace = await createCaseDir("source");
    await fs.cp(syncSourceTemplateDir, sourceWorkspace, { recursive: true });
    return sourceWorkspace;
  };

  it("syncs merged skills into a target workspace", async () => {
    const sourceWorkspace = await cloneSourceTemplate();
    const targetWorkspace = await createCaseDir("target");
    const extraDir = path.join(sourceWorkspace, ".extra");
    const bundledDir = path.join(sourceWorkspace, ".bundled");
    const managedDir = path.join(sourceWorkspace, ".managed");
    const workspaceSkillDir = path.join(sourceWorkspace, "skills", "demo-skill");

    await fs.mkdir(path.join(workspaceSkillDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceSkillDir, ".git", "config"), "gitdir");
    await fs.mkdir(path.join(workspaceSkillDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceSkillDir, "node_modules", "pkg", "index.js"),
      "export {}",
    );

    await withEnv({ HOME: sourceWorkspace, PATH: "" }, () =>
      syncSkillsToWorkspace({
        bundledSkillsDir: bundledDir,
        config: { skills: { load: { extraDirs: [extraDir] } } },
        managedSkillsDir: managedDir,
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
      }),
    );

    const prompt = buildPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(await pathExists(path.join(targetWorkspace, "skills", "demo-skill", ".git"))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(targetWorkspace, "skills", "demo-skill", "node_modules")),
    ).toBe(false);
  });

  it("syncs the explicit agent skill subset instead of inherited defaults", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    await writeSkill({
      description: "Underscore variant",
      dir: path.join(sourceWorkspace, "skills", "foo_bar"),
      name: "foo_bar",
    });
    await writeSkill({
      description: "Dot variant",
      dir: path.join(sourceWorkspace, "skills", "foo.dot"),
      name: "foo.dot",
    });

    await withEnv({ HOME: sourceWorkspace, PATH: "" }, () =>
      syncSkillsToWorkspace({
        agentId: "alpha",
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        config: {
          agents: {
            defaults: {
              skills: ["foo_bar", "foo.dot"],
            },
            list: [{ id: "alpha", skills: ["foo_bar"] }],
          },
        },
        managedSkillsDir: path.join(sourceWorkspace, ".managed"),
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
      }),
    );

    const prompt = buildPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Underscore variant");
    expect(prompt).not.toContain("Dot variant");
    expect(await pathExists(path.join(targetWorkspace, "skills", "foo_bar", "SKILL.md"))).toBe(
      true,
    );
    expect(await pathExists(path.join(targetWorkspace, "skills", "foo.dot", "SKILL.md"))).toBe(
      false,
    );
  });
  it.runIf(process.platform !== "win32")(
    "does not sync workspace skills that resolve outside the source workspace root",
    async () => {
      const sourceWorkspace = await createCaseDir("source");
      const targetWorkspace = await createCaseDir("target");
      const outsideRoot = await createCaseDir("outside");
      const outsideSkillDir = path.join(outsideRoot, "escaped-skill");

      await writeSkill({
        description: "Outside source workspace",
        dir: outsideSkillDir,
        name: "escaped-skill",
      });
      await fs.mkdir(path.join(sourceWorkspace, "skills"), { recursive: true });
      await fs.symlink(
        outsideSkillDir,
        path.join(sourceWorkspace, "skills", "escaped-skill"),
        "dir",
      );

      await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

      const prompt = buildPrompt(targetWorkspace, {
        bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
        managedSkillsDir: path.join(targetWorkspace, ".managed"),
      });

      expect(prompt).not.toContain("escaped-skill");
      expect(
        await pathExists(path.join(targetWorkspace, "skills", "escaped-skill", "SKILL.md")),
      ).toBe(false);
    },
  );
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const traversalName = `../../../skill-sync-escape-${escapeId}`;
    const escapedDest = path.resolve(targetWorkspace, "skills", traversalName);

    await writeSkill({
      description: "Traversal skill",
      dir: path.join(sourceWorkspace, "skills", "safe-traversal-skill"),
      name: traversalName,
    });

    expect(path.relative(path.join(targetWorkspace, "skills"), escapedDest).startsWith("..")).toBe(
      true,
    );
    await expectSyncedSkillConfinement({
      escapedDest,
      safeSkillDirName: "safe-traversal-skill",
      sourceWorkspace,
      targetWorkspace,
    });
  });
  it("keeps synced skills confined under target workspace when frontmatter name is absolute", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const absoluteDest = path.join(os.tmpdir(), `skill-sync-abs-escape-${escapeId}`);

    await fs.rm(absoluteDest, { force: true, recursive: true });
    await writeSkill({
      description: "Absolute skill",
      dir: path.join(sourceWorkspace, "skills", "safe-absolute-skill"),
      name: absoluteDest,
    });

    await expectSyncedSkillConfinement({
      escapedDest: absoluteDest,
      safeSkillDirName: "safe-absolute-skill",
      sourceWorkspace,
      targetWorkspace,
    });
  });
  it("filters skills based on env/config gates", async () => {
    const workspaceDir = await createCaseDir("workspace");
    const skillDir = path.join(workspaceDir, "skills", "image-lab");
    await writeSkill({
      body: "# Image Lab\n",
      description: "Generates images",
      dir: skillDir,
      metadata:
        '{"openclaw":{"requires":{"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY"}}',
      name: "image-lab",
    });

    withEnv({ GEMINI_API_KEY: undefined }, () => {
      const missingPrompt = buildPrompt(workspaceDir, {
        config: { skills: { entries: { "image-lab": { apiKey: "" } } } },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });
      expect(missingPrompt).not.toContain("image-lab");

      const enabledPrompt = buildPrompt(workspaceDir, {
        config: {
          skills: { entries: { "image-lab": { apiKey: "test-key" } } }, // Pragma: allowlist secret
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });
      expect(enabledPrompt).toContain("image-lab");
    });
  });
  it("applies skill filters, including empty lists", async () => {
    const workspaceDir = await createCaseDir("workspace");
    await writeSkill({
      description: "Alpha skill",
      dir: path.join(workspaceDir, "skills", "alpha"),
      name: "alpha",
    });
    await writeSkill({
      description: "Beta skill",
      dir: path.join(workspaceDir, "skills", "beta"),
      name: "beta",
    });

    const filteredPrompt = buildPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["alpha"],
    });
    expect(filteredPrompt).toContain("alpha");
    expect(filteredPrompt).not.toContain("beta");

    const emptyPrompt = buildPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: [],
    });
    expect(emptyPrompt).toBe("");
  });

  it("syncs remote-eligible filtered skills into the target workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    await writeSkill({
      description: "Sandbox-only bin",
      dir: path.join(sourceWorkspace, "skills", "remote-only"),
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
      name: "remote-only",
    });

    await withEnv({ HOME: sourceWorkspace, PATH: "" }, () =>
      syncSkillsToWorkspace({
        agentId: "alpha",
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        config: {
          agents: {
            defaults: {
              skills: ["remote-only"],
            },
            list: [{ id: "alpha" }],
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
        managedSkillsDir: path.join(sourceWorkspace, ".managed"),
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
      }),
    );

    expect(await pathExists(path.join(targetWorkspace, "skills", "remote-only", "SKILL.md"))).toBe(
      true,
    );
  });
});
