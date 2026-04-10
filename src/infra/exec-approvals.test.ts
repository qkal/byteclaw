import { describe, expect, it } from "vitest";
import { normalizeSafeBins } from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import { type ExecAllowlistEntry, evaluateExecAllowlist } from "./exec-approvals.js";

describe("exec approvals allowlist evaluation", () => {
  function evaluateAutoAllowSkills(params: {
    analysis: {
      ok: boolean;
      segments: {
        raw: string;
        argv: string[];
        resolution: ReturnType<typeof makeMockCommandResolution>;
      }[];
    };
    resolvedPath: string;
  }) {
    return evaluateExecAllowlist({
      allowlist: [],
      analysis: params.analysis,
      autoAllowSkills: true,
      cwd: "/tmp",
      safeBins: new Set(),
      skillBins: [{ name: "skill-bin", resolvedPath: params.resolvedPath }],
    });
  }

  function expectAutoAllowSkillsMiss(result: ReturnType<typeof evaluateExecAllowlist>): void {
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
  }

  it("satisfies allowlist on exact match", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          argv: ["tool"],
          raw: "tool",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "tool",
              rawExecutable: "tool",
              resolvedPath: "/usr/bin/tool",
            }),
          }),
        },
      ],
    };
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/tool" }];
    const result = evaluateExecAllowlist({
      allowlist,
      analysis,
      cwd: "/tmp",
      safeBins: new Set(),
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
  });

  it("satisfies allowlist via safe bins", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          argv: ["jq", ".foo"],
          raw: "jq .foo",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "jq",
              rawExecutable: "jq",
              resolvedPath: "/usr/bin/jq",
            }),
          }),
        },
      ],
    };
    const result = evaluateExecAllowlist({
      allowlist: [],
      analysis,
      cwd: "/tmp",
      safeBins: normalizeSafeBins(["jq"]),
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches).toEqual([]);
  });

  it("satisfies allowlist via auto-allow skills", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          argv: ["skill-bin", "--help"],
          raw: "skill-bin",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "skill-bin",
              rawExecutable: "skill-bin",
              resolvedPath: "/opt/skills/skill-bin",
            }),
          }),
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/opt/skills/skill-bin",
    });
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("does not satisfy auto-allow skills for explicit relative paths", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          argv: ["./skill-bin", "--help"],
          raw: "./skill-bin",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "skill-bin",
              rawExecutable: "./skill-bin",
              resolvedPath: "/tmp/skill-bin",
            }),
          }),
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/tmp/skill-bin",
    });
    expectAutoAllowSkillsMiss(result);
  });

  it("does not satisfy auto-allow skills when command resolution is missing", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          argv: ["skill-bin", "--help"],
          raw: "skill-bin --help",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "skill-bin",
              rawExecutable: "skill-bin",
            }),
          }),
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/opt/skills/skill-bin",
    });
    expectAutoAllowSkillsMiss(result);
  });

  it("returns empty segment details for chain misses", () => {
    const segment = {
      argv: ["tool"],
      raw: "tool",
      resolution: makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          executableName: "tool",
          rawExecutable: "tool",
          resolvedPath: "/usr/bin/tool",
        }),
      }),
    };
    const analysis = {
      chains: [[segment]],
      ok: true,
      segments: [segment],
    };
    const result = evaluateExecAllowlist({
      allowlist: [{ pattern: "/usr/bin/other" }],
      analysis,
      cwd: "/tmp",
      safeBins: new Set(),
    });
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.allowlistMatches).toEqual([]);
    expect(result.segmentSatisfiedBy).toEqual([]);
  });

  it("aggregates segment satisfaction across chains", () => {
    const allowlistSegment = {
      argv: ["tool"],
      raw: "tool",
      resolution: makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          executableName: "tool",
          rawExecutable: "tool",
          resolvedPath: "/usr/bin/tool",
        }),
      }),
    };
    const safeBinSegment = {
      argv: ["jq", ".foo"],
      raw: "jq .foo",
      resolution: makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          executableName: "jq",
          rawExecutable: "jq",
          resolvedPath: "/usr/bin/jq",
        }),
      }),
    };
    const analysis = {
      chains: [[allowlistSegment], [safeBinSegment]],
      ok: true,
      segments: [allowlistSegment, safeBinSegment],
    };
    const result = evaluateExecAllowlist({
      allowlist: [{ pattern: "/usr/bin/tool" }],
      analysis,
      cwd: "/tmp",
      safeBins: normalizeSafeBins(["jq"]),
    });
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
    expect(result.segmentSatisfiedBy).toEqual(["allowlist", "safeBins"]);
  });
});
