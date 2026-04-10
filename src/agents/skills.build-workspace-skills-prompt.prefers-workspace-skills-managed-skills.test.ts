import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-prompt-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

describe("buildWorkspaceSkillsPrompt", () => {
  it("prefers workspace skills over managed skills", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedSkillDir = path.join(managedDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      body: "# Bundled\n",
      description: "Bundled version",
      dir: bundledSkillDir,
      name: "demo-skill",
    });
    await writeSkill({
      body: "# Managed\n",
      description: "Managed version",
      dir: managedSkillDir,
      name: "demo-skill",
    });
    await writeSkill({
      body: "# Workspace\n",
      description: "Workspace version",
      dir: workspaceSkillDir,
      name: "demo-skill",
    });

    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: managedDir,
      }),
    );

    expect(prompt).toContain("Workspace version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
  });
  it("gates by bins, config, and always", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const skillsDir = path.join(workspaceDir, "skills");

    await writeSkill({
      description: "Needs a bin",
      dir: path.join(skillsDir, "bin-skill"),
      metadata: '{"openclaw":{"requires":{"bins":["fakebin"]}}}',
      name: "bin-skill",
    });
    await writeSkill({
      description: "Needs any bin",
      dir: path.join(skillsDir, "anybin-skill"),
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","fakebin"]}}}',
      name: "anybin-skill",
    });
    await writeSkill({
      description: "Needs config",
      dir: path.join(skillsDir, "config-skill"),
      metadata: '{"openclaw":{"requires":{"config":["browser.enabled"]}}}',
      name: "config-skill",
    });
    await writeSkill({
      description: "Always on",
      dir: path.join(skillsDir, "always-skill"),
      metadata: '{"openclaw":{"always":true,"requires":{"env":["MISSING"]}}}',
      name: "always-skill",
    });
    await writeSkill({
      description: "Needs env",
      dir: path.join(skillsDir, "env-skill"),
      metadata: '{"openclaw":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
      name: "env-skill",
    });

    const managedSkillsDir = path.join(workspaceDir, ".managed");
    const defaultPrompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        eligibility: {
          remote: {
            hasAnyBin: () => false,
            hasBin: () => false,
            note: "",
            platforms: ["linux"],
          },
        },
        managedSkillsDir,
      }),
    );
    expect(defaultPrompt).toContain("always-skill");
    expect(defaultPrompt).toContain("config-skill");
    expect(defaultPrompt).not.toContain("bin-skill");
    expect(defaultPrompt).not.toContain("anybin-skill");
    expect(defaultPrompt).not.toContain("env-skill");

    const gatedPrompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        config: {
          browser: { enabled: false },
          skills: { entries: { "env-skill": { apiKey: "ok" } } }, // Pragma: allowlist secret
        },
        eligibility: {
          remote: {
            hasAnyBin: (bins: string[]) => bins.includes("fakebin"),
            hasBin: (bin: string) => bin === "fakebin",
            note: "",
            platforms: ["linux"],
          },
        },
        managedSkillsDir,
      }),
    );
    expect(gatedPrompt).toContain("bin-skill");
    expect(gatedPrompt).toContain("anybin-skill");
    expect(gatedPrompt).toContain("env-skill");
    expect(gatedPrompt).toContain("always-skill");
    expect(gatedPrompt).not.toContain("config-skill");
  });
  it("uses skillKey for config lookups", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const skillDir = path.join(workspaceDir, "skills", "alias-skill");
    await writeSkill({
      description: "Uses skillKey",
      dir: skillDir,
      metadata: '{"openclaw":{"skillKey":"alias"}}',
      name: "alias-skill",
    });

    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        config: { skills: { entries: { alias: { enabled: false } } } },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      }),
    );
    expect(prompt).not.toContain("alias-skill");
  });
});
