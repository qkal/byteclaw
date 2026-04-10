import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { writeSkill } from "./skills.test-helpers.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildSkillsPrompt(workspaceDir: string, managedDir: string, bundledDir: string): string {
  return buildWorkspaceSkillsPrompt(workspaceDir, {
    bundledSkillsDir: bundledDir,
    managedSkillsDir: managedDir,
  });
}

async function createWorkspaceSkillDirs() {
  const workspaceDir = await createTempDir("openclaw-");
  return {
    bundledDir: path.join(workspaceDir, ".bundled"),
    managedDir: path.join(workspaceDir, ".managed"),
    workspaceDir,
  };
}

describe("buildWorkspaceSkillsPrompt — .agents/skills/ directories", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await createTempDir("openclaw-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("loads project .agents/skills/ above managed and below workspace", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      description: "Managed version",
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
    });
    await writeSkill({
      description: "Project agents version",
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
    });

    // Project .agents/skills/ wins over managed
    const prompt1 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt1).toContain("Project agents version");
    expect(prompt1).not.toContain("Managed version");

    // Workspace wins over project .agents/skills/
    await writeSkill({
      description: "Workspace version",
      dir: path.join(workspaceDir, "skills", "shared-skill"),
      name: "shared-skill",
    });

    const prompt2 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt2).toContain("Workspace version");
    expect(prompt2).not.toContain("Project agents version");
  });

  it("loads personal ~/.agents/skills/ above managed and below project .agents/skills/", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      description: "Managed version",
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
    });
    await writeSkill({
      description: "Personal agents version",
      dir: path.join(fakeHome, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
    });

    // Personal wins over managed
    const prompt1 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt1).toContain("Personal agents version");
    expect(prompt1).not.toContain("Managed version");

    // Project .agents/skills/ wins over personal
    await writeSkill({
      description: "Project agents version",
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
    });

    const prompt2 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt2).toContain("Project agents version");
    expect(prompt2).not.toContain("Personal agents version");
  });

  it("loads unique skills from all .agents/skills/ sources alongside others", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      description: "Managed only skill",
      dir: path.join(managedDir, "managed-only"),
      name: "managed-only",
    });
    await writeSkill({
      description: "Personal only skill",
      dir: path.join(fakeHome, ".agents", "skills", "personal-only"),
      name: "personal-only",
    });
    await writeSkill({
      description: "Project only skill",
      dir: path.join(workspaceDir, ".agents", "skills", "project-only"),
      name: "project-only",
    });
    await writeSkill({
      description: "Workspace only skill",
      dir: path.join(workspaceDir, "skills", "workspace-only"),
      name: "workspace-only",
    });

    const prompt = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt).toContain("managed-only");
    expect(prompt).toContain("personal-only");
    expect(prompt).toContain("project-only");
    expect(prompt).toContain("workspace-only");
  });
});
