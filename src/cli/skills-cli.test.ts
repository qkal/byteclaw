import { describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

// Unit tests: don't pay the runtime cost of loading/parsing the real skills loader.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  formatSkillsForPrompt: () => "",
  loadSkillsFromDir: () => ({ skills: [] }),
}));

function createMockSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    always: false,
    baseDir: "/path/to",
    blockedByAllowlist: false,
    bundled: false,
    description: "A test skill",
    disabled: false,
    eligible: true,
    emoji: "🧪",
    filePath: "/path/to/SKILL.md",
    homepage: "https://example.com",
    name: "test-skill",
    skillKey: "test-skill",
    source: "bundled",
    ...createEmptyInstallChecks(),
    ...overrides,
  };
}

function createMockReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    managedSkillsDir: "/managed",
    skills,
    workspaceDir: "/workspace",
  };
}

describe("skills-cli", () => {
  describe("formatSkillsList", () => {
    it("formats empty skills list", () => {
      const report = createMockReport([]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("No skills found");
      expect(output).toContain("openclaw skills search");
    });

    it("formats skills list with eligible skill", () => {
      const report = createMockReport([
        createMockSkill({
          description: "Capture UI screenshots",
          eligible: true,
          emoji: "📸",
          name: "peekaboo",
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("peekaboo");
      expect(output).toContain("📸");
      expect(output).toContain("✓");
    });

    it("formats skills list with disabled skill", () => {
      const report = createMockReport([
        createMockSkill({
          disabled: true,
          eligible: false,
          name: "disabled-skill",
        }),
      ]);
      const output = formatSkillsList(report, {});
      expect(output).toContain("disabled-skill");
      expect(output).toContain("disabled");
    });

    it("formats skills list with missing requirements", () => {
      const report = createMockReport([
        createMockSkill({
          eligible: false,
          missing: {
            anyBins: ["rg", "grep"],
            bins: ["ffmpeg"],
            config: [],
            env: ["API_KEY"],
            os: ["darwin"],
          },
          name: "needs-stuff",
        }),
      ]);
      const output = formatSkillsList(report, { verbose: true });
      expect(output).toContain("needs-stuff");
      expect(output).toContain("needs setup");
      expect(output).toContain("anyBins");
      expect(output).toContain("os:");
    });

    it("filters to eligible only with --eligible flag", () => {
      const report = createMockReport([
        createMockSkill({ eligible: true, name: "eligible-one" }),
        createMockSkill({
          disabled: true,
          eligible: false,
          name: "not-eligible",
        }),
      ]);
      const output = formatSkillsList(report, { eligible: true });
      expect(output).toContain("eligible-one");
      expect(output).not.toContain("not-eligible");
    });
  });

  describe("formatSkillInfo", () => {
    it("returns not found message for unknown skill", () => {
      const report = createMockReport([]);
      const output = formatSkillInfo(report, "unknown-skill", {});
      expect(output).toContain("not found");
      expect(output).toContain("openclaw skills install");
    });

    it("shows detailed info for a skill", () => {
      const report = createMockReport([
        createMockSkill({
          description: "A detailed description",
          homepage: "https://example.com",
          missing: {
            anyBins: [],
            bins: [],
            config: [],
            env: ["API_KEY"],
            os: [],
          },
          name: "detailed-skill",
          requirements: {
            anyBins: ["rg", "grep"],
            bins: ["node"],
            config: [],
            env: ["API_KEY"],
            os: [],
          },
        }),
      ]);
      const output = formatSkillInfo(report, "detailed-skill", {});
      expect(output).toContain("detailed-skill");
      expect(output).toContain("A detailed description");
      expect(output).toContain("https://example.com");
      expect(output).toContain("node");
      expect(output).toContain("Any binaries");
      expect(output).toContain("API_KEY");
    });

    it("shows API key storage guidance for the active config path", () => {
      const report = createMockReport([
        createMockSkill({
          eligible: false,
          missing: {
            anyBins: [],
            bins: [],
            config: [],
            env: ["API_KEY"],
            os: [],
          },
          name: "env-aware-skill",
          primaryEnv: "API_KEY",
          requirements: {
            anyBins: [],
            bins: [],
            config: [],
            env: ["API_KEY"],
            os: [],
          },
          skillKey: "env-aware-skill",
        }),
      ]);

      const output = formatSkillInfo(report, "env-aware-skill", {});
      expect(output).toContain("OPENCLAW_CONFIG_PATH");
      expect(output).toContain("default: ~/.openclaw/openclaw.json");
      expect(output).toContain("skills.entries.env-aware-skill.apiKey");
    });

    it("normalizes text-presentation emoji selectors in info output", () => {
      const report = createMockReport([
        createMockSkill({
          emoji: "🎛\uFE0E",
          name: "info-emoji",
        }),
      ]);

      const output = formatSkillInfo(report, "info-emoji", {});
      expect(output).toContain("🎛️");
    });
  });

  describe("formatSkillsCheck", () => {
    it("shows summary of skill status", () => {
      const report = createMockReport([
        createMockSkill({ eligible: true, name: "ready-1" }),
        createMockSkill({ eligible: true, name: "ready-2" }),
        createMockSkill({
          eligible: false,
          missing: { anyBins: [], bins: ["go"], config: [], env: [], os: [] },
          name: "not-ready",
        }),
        createMockSkill({ disabled: true, eligible: false, name: "disabled" }),
      ]);
      const output = formatSkillsCheck(report, {});
      expect(output).toContain("2"); // Eligible count
      expect(output).toContain("ready-1");
      expect(output).toContain("ready-2");
      expect(output).toContain("not-ready");
      expect(output).toContain("go"); // Missing binary
      expect(output).toContain("openclaw skills update");
    });

    it("normalizes text-presentation emoji selectors in check output", () => {
      const report = createMockReport([
        createMockSkill({ eligible: true, emoji: "🎛\uFE0E", name: "ready-emoji" }),
        createMockSkill({
          eligible: false,
          emoji: "🎙\uFE0E",
          missing: { anyBins: [], bins: ["ffmpeg"], config: [], env: [], os: [] },
          name: "missing-emoji",
        }),
      ]);

      const output = formatSkillsCheck(report, {});
      expect(output).toContain("🎛️ ready-emoji");
      expect(output).toContain("🎙️ missing-emoji");
    });
  });

  describe("JSON output", () => {
    it.each([
      {
        assert: (parsed: Record<string, unknown>) => {
          const skills = parsed.skills as Record<string, unknown>[];
          expect(skills).toHaveLength(1);
          expect(skills[0]?.name).toBe("json-skill");
        },
        formatter: "list",
        output: formatSkillsList(createMockReport([createMockSkill({ name: "json-skill" })]), {
          json: true,
        }),
      },
      {
        assert: (parsed: Record<string, unknown>) => {
          expect(parsed.name).toBe("info-skill");
        },
        formatter: "info",
        output: formatSkillInfo(
          createMockReport([createMockSkill({ name: "info-skill" })]),
          "info-skill",
          { json: true },
        ),
      },
      {
        assert: (parsed: Record<string, unknown>) => {
          const summary = parsed.summary as Record<string, unknown>;
          expect(summary.eligible).toBe(1);
          expect(summary.total).toBe(2);
        },
        formatter: "check",
        output: formatSkillsCheck(
          createMockReport([
            createMockSkill({ eligible: true, name: "skill-1" }),
            createMockSkill({ eligible: false, name: "skill-2" }),
          ]),
          { json: true },
        ),
      },
    ])("outputs JSON with --json flag for $formatter", ({ output, assert }) => {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      assert(parsed);
    });

    it("sanitizes ANSI and C1 controls in skills list JSON output", () => {
      const report = createMockReport([
        createMockSkill({
          description: "desc\u0093\u001b[2J\u001b[33m colored\u001b[0m",
          emoji: "\u001b[31m📧\u001b[0m\u009f",
          name: "json-skill",
        }),
      ]);

      const output = formatSkillsList(report, { json: true });
      const parsed = JSON.parse(output) as {
        skills: { emoji: string; description: string }[];
      };

      expect(parsed.skills[0]?.emoji).toBe("📧");
      expect(parsed.skills[0]?.description).toBe("desc colored");
      expect(output).not.toContain(String.raw`\u001b`);
    });

    it("sanitizes skills info JSON output", () => {
      const report = createMockReport([
        createMockSkill({
          description: "hi\u0091",
          emoji: "\u001b[31m🎙\u001b[0m\u009f",
          homepage: "https://example.com/\u0092docs",
          name: "info-json",
        }),
      ]);

      const output = formatSkillInfo(report, "info-json", { json: true });
      const parsed = JSON.parse(output) as {
        emoji: string;
        description: string;
        homepage: string;
      };

      expect(parsed.emoji).toBe("🎙");
      expect(parsed.description).toBe("hi");
      expect(parsed.homepage).toBe("https://example.com/docs");
    });
  });
});
