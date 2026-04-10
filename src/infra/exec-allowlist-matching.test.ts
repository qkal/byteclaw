import { describe, expect, it } from "vitest";
import { type ExecAllowlistEntry, matchAllowlist } from "./exec-approvals.js";

describe("exec allowlist matching", () => {
  const baseResolution = {
    executableName: "rg",
    rawExecutable: "rg",
    resolvedPath: "/opt/homebrew/bin/rg",
  };

  it("handles wildcard and path matching semantics", () => {
    const cases: { entries: ExecAllowlistEntry[]; expectedPattern: string | null }[] = [
      { entries: [{ pattern: "RG" }], expectedPattern: null },
      { entries: [{ pattern: "/opt/**/rg" }], expectedPattern: "/opt/**/rg" },
      { entries: [{ pattern: "/opt/*/rg" }], expectedPattern: null },
    ];
    for (const { entries, expectedPattern } of cases) {
      const match = matchAllowlist(entries, baseResolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    }
  });

  it("matches bare wildcard patterns against arbitrary resolved executables", () => {
    const cases = [
      baseResolution,
      {
        executableName: "python3",
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
      },
    ] as const;
    for (const resolution of cases) {
      expect(matchAllowlist([{ pattern: "*" }], resolution)?.pattern).toBe("*");
    }
  });

  it("matches absolute paths containing regex metacharacters literally", () => {
    const plusPathCases = ["/usr/bin/g++", "/usr/bin/clang++"] as const;
    for (const candidatePath of plusPathCases) {
      const match = matchAllowlist([{ pattern: candidatePath }], {
        executableName: candidatePath.split("/").at(-1) ?? candidatePath,
        rawExecutable: candidatePath,
        resolvedPath: candidatePath,
      });
      expect(match?.pattern).toBe(candidatePath);
    }

    const literalCases = [
      {
        pattern: "/usr/bin/*++",
        resolution: {
          executableName: "g++",
          rawExecutable: "/usr/bin/g++",
          resolvedPath: "/usr/bin/g++",
        },
      },
      {
        pattern: "/opt/builds/tool[1](stable)",
        resolution: {
          executableName: "tool[1](stable)",
          rawExecutable: "/opt/builds/tool[1](stable)",
          resolvedPath: "/opt/builds/tool[1](stable)",
        },
      },
    ] as const;
    for (const { pattern, resolution } of literalCases) {
      expect(matchAllowlist([{ pattern }], resolution)?.pattern).toBe(pattern);
    }
  });
});
