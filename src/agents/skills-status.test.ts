import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";

describe("buildWorkspaceSkillStatus", () => {
  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      frontmatter: {},
      metadata: {
        install: [
          {
            bins: ["fakebin"],
            formula: "fake",
            id: "brew",
            kind: "brew",
            label: "Install fake (brew)",
          },
        ],
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
      },
      skill: createFixtureSkill({
        baseDir: "/tmp",
        description: "test",
        filePath: "/tmp/os-scoped",
        name: "os-scoped",
        source: "test",
      }),
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.install).toEqual([]);
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}
