import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      frontmatter: {},
      skill: createFixtureSkill({
        baseDir: "/app/skills/demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        name: "demo-skill",
        source: "openclaw-bundled",
      }),
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      frontmatter: {},
      skill: createFixtureSkill({
        baseDir: "/app/skills/hidden-skill",
        description: "Hidden",
        disableModelInvocation: true,
        filePath: "/app/skills/hidden-skill/SKILL.md",
        name: "hidden-skill",
        source: "openclaw-workspace",
      }),
    };

    const prompt = resolveSkillsPromptForRun({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      frontmatter: {},
      skill: createFixtureSkill({
        baseDir: "/app/skills/github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        name: "github",
        source: "openclaw-workspace",
      }),
    };
    const hidden: SkillEntry = {
      frontmatter: {},
      skill: createFixtureSkill({
        baseDir: "/app/skills/hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        name: "hidden-skill",
        source: "openclaw-workspace",
      }),
    };

    const prompt = resolveSkillsPromptForRun({
      agentId: "writer",
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      entries: [visible, hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      frontmatter: {},
      skill: createFixtureSkill({
        baseDir: "/app/skills/weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        name: "weather",
        source: "openclaw-workspace",
      }),
    };
    const explicitEntry: SkillEntry = {
      frontmatter: {},
      skill: createFixtureSkill({
        baseDir: "/app/skills/docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        name: "docs-search",
        source: "openclaw-workspace",
      }),
    };

    const prompt = resolveSkillsPromptForRun({
      agentId: "writer",
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      entries: [inheritedEntry, explicitEntry],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}
