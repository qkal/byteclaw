import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

describe("buildWorkspaceSkillsPrompt", () => {
  it("applies bundled allowlist without affecting workspace skills", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    const bundledDir = path.join(workspaceDir, ".bundled");
    const bundledSkillDir = path.join(bundledDir, "peekaboo");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      body: "# Peekaboo\n",
      description: "Capture UI",
      dir: bundledSkillDir,
      name: "peekaboo",
    });
    await writeSkill({
      body: "# Workspace\n",
      description: "Workspace version",
      dir: workspaceSkillDir,
      name: "demo-skill",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      bundledSkillsDir: bundledDir,
      config: { skills: { allowBundled: ["missing-skill"] } },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("peekaboo");
  });
});
