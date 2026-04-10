import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let listSkillCommandsForAgents: typeof import("./skill-commands.js").listSkillCommandsForAgents;
let listSkillCommandsForWorkspace: typeof import("./skill-commands.js").listSkillCommandsForWorkspace;
let resolveSkillCommandInvocation: typeof import("./skill-commands.js").resolveSkillCommandInvocation;
let skillCommandsTesting: typeof import("./skill-commands.js").__testing;

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function resolveWorkspaceSkills(
  workspaceDir: string,
): { skillName: string; description: string }[] {
  const dirName = path.basename(workspaceDir);
  if (dirName === "main") {
    return [{ description: "Demo skill", skillName: "demo-skill" }];
  }
  if (dirName === "research") {
    return [
      { description: "Demo skill 2", skillName: "demo-skill" },
      { description: "Extra skill", skillName: "extra-skill" },
    ];
  }
  if (dirName === "shared-defaults") {
    return [
      { description: "Alpha skill", skillName: "alpha-skill" },
      { description: "Beta skill", skillName: "beta-skill" },
      { description: "Hidden skill", skillName: "hidden-skill" },
    ];
  }
  return [];
}

function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    reservedNames?: Set<string>;
    skillFilter?: string[];
    agentId?: string;
    config?: {
      agents?: {
        defaults?: { skills?: string[] };
        list?: { id: string; skills?: string[] }[];
      };
    };
  },
) {
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(String(reserved).toLowerCase());
  }
  const agentSkills = opts?.config?.agents?.list?.find((entry) => entry.id === opts?.agentId);
  const filter =
    opts?.skillFilter ??
    (agentSkills && Object.hasOwn(agentSkills, "skills")
      ? agentSkills.skills
      : opts?.config?.agents?.defaults?.skills);
  const entries =
    filter === undefined
      ? resolveWorkspaceSkills(workspaceDir)
      : resolveWorkspaceSkills(workspaceDir).filter((entry) =>
          filter.some((skillName) => skillName === entry.skillName),
        );

  return entries.map((entry) => {
    const base = entry.skillName.replace(/-/g, "_");
    const name = resolveUniqueSkillCommandName(base, used);
    return { description: entry.description, name, skillName: entry.skillName };
  });
}

vi.mock("./commands-registry.js", () => ({
  listChatCommands: () => [],
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({}),
}));

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillCommandSpecs,
}));

beforeAll(async () => {
  ({
    listSkillCommandsForAgents,
    listSkillCommandsForWorkspace,
    resolveSkillCommandInvocation,
    __testing: skillCommandsTesting,
  } = await import("./skill-commands.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSkillCommandInvocation", () => {
  it("matches skill commands and parses args", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/demo_skill do the thing",
      skillCommands: [{ description: "Demo", name: "demo_skill", skillName: "demo-skill" }],
    });
    expect(invocation?.command.skillName).toBe("demo-skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("supports /skill with name argument", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo_skill do the thing",
      skillCommands: [{ description: "Demo", name: "demo_skill", skillName: "demo-skill" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBe("do the thing");
  });

  it("normalizes /skill lookup names", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill demo-skill",
      skillCommands: [{ description: "Demo", name: "demo_skill", skillName: "demo-skill" }],
    });
    expect(invocation?.command.name).toBe("demo_skill");
    expect(invocation?.args).toBeUndefined();
  });

  it("returns null for unknown commands", () => {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: "/unknown arg",
      skillCommands: [{ description: "Demo", name: "demo_skill", skillName: "demo-skill" }],
    });
    expect(invocation).toBeNull();
  });
});

describe("listSkillCommandsForAgents", () => {
  const tempDirs: string[] = [];
  const makeTempDir = async (prefix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("deduplicates by skillName across agents, keeping the first registration", async () => {
    const baseDir = await makeTempDir("openclaw-skills-");
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      cfg: {
        agents: {
          list: [
            { id: "main", workspace: mainWorkspace },
            { id: "research", workspace: researchWorkspace },
          ],
        },
      },
    });
    const names = commands.map((entry) => entry.name);
    expect(names).toContain("demo_skill");
    expect(names).not.toContain("demo_skill_2");
    expect(names).toContain("extra_skill");
  });

  it("scopes to specific agents when agentIds is provided", async () => {
    const baseDir = await makeTempDir("openclaw-skills-filter-");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["research"],
      cfg: {
        agents: {
          list: [{ id: "research", skills: ["extra-skill"], workspace: researchWorkspace }],
        },
      },
    });

    expect(commands.map((entry) => entry.name)).toEqual(["extra_skill"]);
    expect(commands.map((entry) => entry.skillName)).toEqual(["extra-skill"]);
  });

  it("prevents cross-agent skill leakage when each agent has an allowlist", async () => {
    const baseDir = await makeTempDir("openclaw-skills-leak-");
    const mainWorkspace = path.join(baseDir, "main");
    const researchWorkspace = path.join(baseDir, "research");
    await fs.mkdir(mainWorkspace, { recursive: true });
    await fs.mkdir(researchWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["main", "research"],
      cfg: {
        agents: {
          list: [
            { id: "main", skills: ["demo-skill"], workspace: mainWorkspace },
            { id: "research", skills: ["extra-skill"], workspace: researchWorkspace },
          ],
        },
      },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("merges allowlists for agents that share one workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-shared-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["main", "research"],
      cfg: {
        agents: {
          list: [
            { id: "main", skills: ["demo-skill"], workspace: sharedWorkspace },
            { id: "research", skills: ["extra-skill"], workspace: sharedWorkspace },
          ],
        },
      },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("deduplicates overlapping allowlists for shared workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-overlap-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["agent-a", "agent-b"],
      cfg: {
        agents: {
          list: [
            { id: "agent-a", skills: ["extra-skill"], workspace: sharedWorkspace },
            { id: "agent-b", skills: ["extra-skill", "demo-skill"], workspace: sharedWorkspace },
          ],
        },
      },
    });

    // Both agents allowlist "extra-skill"; it should appear once, not twice.
    expect(commands.map((entry) => entry.skillName)).toEqual(["demo-skill", "extra-skill"]);
    expect(commands.map((entry) => entry.name)).toEqual(["demo_skill", "extra_skill"]);
  });

  it("keeps workspace unrestricted when one co-tenant agent has no skills filter", async () => {
    const baseDir = await makeTempDir("openclaw-skills-unfiltered-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["restricted", "unrestricted"],
      cfg: {
        agents: {
          list: [
            { id: "restricted", skills: ["extra-skill"], workspace: sharedWorkspace },
            { id: "unrestricted", workspace: sharedWorkspace },
          ],
        },
      },
    });

    const skillNames = commands.map((entry) => entry.skillName);
    expect(skillNames).toContain("demo-skill");
    expect(skillNames).toContain("extra-skill");
  });

  it("merges empty allowlist with non-empty allowlist for shared workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-empty-");
    const sharedWorkspace = path.join(baseDir, "research");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["locked", "partial"],
      cfg: {
        agents: {
          list: [
            { id: "locked", skills: [], workspace: sharedWorkspace },
            { id: "partial", skills: ["extra-skill"], workspace: sharedWorkspace },
          ],
        },
      },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["extra-skill"]);
  });

  it("uses inherited defaults for agents that share one workspace", async () => {
    const baseDir = await makeTempDir("openclaw-skills-defaults-");
    const sharedWorkspace = path.join(baseDir, "shared-defaults");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["alpha", "beta", "gamma"],
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill"],
          },
          list: [
            { id: "alpha", workspace: sharedWorkspace },
            { id: "beta", skills: ["beta-skill"], workspace: sharedWorkspace },
            { id: "gamma", workspace: sharedWorkspace },
          ],
        },
      },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill", "beta-skill"]);
  });

  it("does not inherit defaults when an agent sets an explicit empty skills list", async () => {
    const baseDir = await makeTempDir("openclaw-skills-defaults-empty-");
    const sharedWorkspace = path.join(baseDir, "shared-defaults");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["alpha", "beta"],
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill", "hidden-skill"],
          },
          list: [
            { id: "alpha", skills: [], workspace: sharedWorkspace },
            { id: "beta", skills: ["beta-skill"], workspace: sharedWorkspace },
          ],
        },
      },
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["beta-skill"]);
  });

  it("skips agents with missing workspaces gracefully", async () => {
    const baseDir = await makeTempDir("openclaw-skills-missing-");
    const validWorkspace = path.join(baseDir, "research");
    const missingWorkspace = path.join(baseDir, "nonexistent");
    await fs.mkdir(validWorkspace, { recursive: true });

    const commands = listSkillCommandsForAgents({
      agentIds: ["valid", "broken"],
      cfg: {
        agents: {
          list: [
            { id: "valid", workspace: validWorkspace },
            { id: "broken", workspace: missingWorkspace },
          ],
        },
      },
    });

    // The valid agent's skills should still be listed despite the broken one.
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((entry) => entry.skillName)).toContain("demo-skill");
  });
});

describe("listSkillCommandsForWorkspace", () => {
  const tempDirs: string[] = [];
  const makeTempDir = async (prefix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("inherits defaults when agentId is provided without an explicit skill filter", async () => {
    const baseDir = await makeTempDir("openclaw-skills-workspace-defaults-");
    const sharedWorkspace = path.join(baseDir, "shared-defaults");
    await fs.mkdir(sharedWorkspace, { recursive: true });

    const commands = listSkillCommandsForWorkspace({
      agentId: "alpha",
      cfg: {
        agents: {
          defaults: {
            skills: ["alpha-skill"],
          },
          list: [{ id: "alpha", workspace: sharedWorkspace }],
        },
      },
      workspaceDir: sharedWorkspace,
    });

    expect(commands.map((entry) => entry.skillName)).toEqual(["alpha-skill"]);
  });
});

describe("dedupeBySkillName", () => {
  it("keeps the first entry when multiple commands share a skillName", () => {
    const input = [
      { description: "GitHub", name: "github", skillName: "github" },
      { description: "GitHub", name: "github_2", skillName: "github" },
      { description: "Weather", name: "weather", skillName: "weather" },
      { description: "Weather", name: "weather_2", skillName: "weather" },
    ];
    const output = skillCommandsTesting.dedupeBySkillName(input);
    expect(output.map((e) => e.name)).toEqual(["github", "weather"]);
  });

  it("matches skillName case-insensitively", () => {
    const input = [
      { description: "ClawHub", name: "ClawHub", skillName: "ClawHub" },
      { description: "ClawHub", name: "clawhub_2", skillName: "clawhub" },
    ];
    const output = skillCommandsTesting.dedupeBySkillName(input);
    expect(output).toHaveLength(1);
    expect(output[0]?.name).toBe("ClawHub");
  });

  it("passes through commands with an empty skillName", () => {
    const input = [
      { description: "A", name: "a", skillName: "" },
      { description: "B", name: "b", skillName: "" },
    ];
    expect(skillCommandsTesting.dedupeBySkillName(input)).toHaveLength(2);
  });

  it("returns an empty array for empty input", () => {
    expect(skillCommandsTesting.dedupeBySkillName([])).toEqual([]);
  });
});
