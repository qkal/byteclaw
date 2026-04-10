import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
  makeTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  isSafeBinUsage,
  normalizeSafeBins,
  resolveSafeBins,
} from "./exec-approvals.js";
import {
  SAFE_BIN_PROFILES,
  SAFE_BIN_PROFILE_FIXTURES,
  resolveSafeBinProfiles,
} from "./exec-safe-bin-policy.js";

describe("exec approvals safe bins", () => {
  interface SafeBinCase {
    name: string;
    argv: string[];
    resolvedPath: string;
    expected: boolean;
    safeBins?: string[];
    safeBinProfiles?: Readonly<Record<string, { minPositional?: number; maxPositional?: number }>>;
    executableName?: string;
    rawExecutable?: string;
    cwd?: string;
    setup?: (cwd: string) => void;
  }

  function buildDeniedFlagVariantCases(params: {
    executableName: string;
    resolvedPath: string;
    safeBins?: string[];
    flag: string;
    takesValue: boolean;
    label: string;
  }): SafeBinCase[] {
    const value = "blocked";
    const argvVariants: string[][] = [];
    if (!params.takesValue) {
      argvVariants.push([params.executableName, params.flag]);
    } else if (params.flag.startsWith("--")) {
      argvVariants.push([params.executableName, `${params.flag}=${value}`]);
      argvVariants.push([params.executableName, params.flag, value]);
    } else if (params.flag.startsWith("-")) {
      argvVariants.push([params.executableName, `${params.flag}${value}`]);
      argvVariants.push([params.executableName, params.flag, value]);
    } else {
      argvVariants.push([params.executableName, params.flag, value]);
    }
    return argvVariants.map((argv) => ({
      argv,
      executableName: params.executableName,
      expected: false,
      name: `${params.label} (${argv.slice(1).join(" ")})`,
      resolvedPath: params.resolvedPath,
      safeBins: params.safeBins ?? [params.executableName],
    }));
  }

  const deniedFlagCases: SafeBinCase[] = [
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "-o",
      label: "blocks sort output flag",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "--output",
      label: "blocks sort output flag",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "--compress-program",
      label: "blocks sort external program flag",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "--compress-prog",
      label: "blocks sort denied flag abbreviations",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "--files0-fro",
      label: "blocks sort denied flag abbreviations",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "--random-source",
      label: "blocks sort filesystem-dependent flags",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "--temporary-directory",
      label: "blocks sort filesystem-dependent flags",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      flag: "-T",
      label: "blocks sort filesystem-dependent flags",
      resolvedPath: "/usr/bin/sort",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "grep",
      flag: "-R",
      label: "blocks grep recursive flag",
      resolvedPath: "/usr/bin/grep",
      takesValue: false,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "grep",
      flag: "--recursive",
      label: "blocks grep recursive flag",
      resolvedPath: "/usr/bin/grep",
      takesValue: false,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "grep",
      flag: "--file",
      label: "blocks grep file-pattern flag",
      resolvedPath: "/usr/bin/grep",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "jq",
      flag: "-f",
      label: "blocks jq file-program flag",
      resolvedPath: "/usr/bin/jq",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "jq",
      flag: "--from-file",
      label: "blocks jq file-program flag",
      resolvedPath: "/usr/bin/jq",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "wc",
      flag: "--files0-from",
      label: "blocks wc file-list flag",
      resolvedPath: "/usr/bin/wc",
      takesValue: true,
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "wc",
      flag: "--files0-fro",
      label: "blocks wc denied flag abbreviations",
      resolvedPath: "/usr/bin/wc",
      takesValue: true,
    }),
  ];

  const cases: SafeBinCase[] = [
    {
      argv: ["jq", ".foo"],
      expected: true,
      name: "allows safe bins with non-path args",
      resolvedPath: "/usr/bin/jq",
    },
    {
      argv: ["jq", "env"],
      expected: false,
      name: "blocks jq env builtin even when jq is explicitly opted in",
      resolvedPath: "/usr/bin/jq",
    },
    {
      argv: ["jq", "$ENV"],
      expected: false,
      name: "blocks jq $ENV builtin variable even when jq is explicitly opted in",
      resolvedPath: "/usr/bin/jq",
    },
    {
      argv: ["jq", "($ENV).OPENAI_API_KEY"],
      expected: false,
      name: "blocks jq $ENV property access even when jq is explicitly opted in",
      resolvedPath: "/usr/bin/jq",
    },
    {
      argv: ["awk", 'BEGIN { system("id") }'],
      executableName: "awk",
      expected: false,
      name: "blocks awk scripts even when awk is explicitly profiled",
      resolvedPath: "/usr/bin/awk",
      safeBinProfiles: { awk: {} },
      safeBins: ["awk"],
    },
    {
      argv: ["sed", "e"],
      executableName: "sed",
      expected: false,
      name: "blocks sed scripts even when sed is explicitly profiled",
      resolvedPath: "/usr/bin/sed",
      safeBinProfiles: { sed: {} },
      safeBins: ["sed"],
    },
    {
      argv: ["jq", ".foo", "secret.json"],
      expected: false,
      name: "blocks safe bins with file args",
      resolvedPath: "/usr/bin/jq",
      setup: (cwd) => fs.writeFileSync(path.join(cwd, "secret.json"), "{}"),
    },
    {
      argv: ["jq", ".foo"],
      cwd: "/tmp",
      expected: false,
      name: "blocks safe bins resolved from untrusted directories",
      resolvedPath: "/tmp/evil-bin/jq",
    },
    ...deniedFlagCases,
    {
      argv: ["grep", "-e", "needle", ".env"],
      executableName: "grep",
      expected: false,
      name: "blocks grep file positional when pattern uses -e",
      resolvedPath: "/usr/bin/grep",
      safeBins: ["grep"],
    },
    {
      argv: ["grep", "-e", "needle", "--", ".env"],
      executableName: "grep",
      expected: false,
      name: "blocks grep file positional after -- terminator",
      resolvedPath: "/usr/bin/grep",
      safeBins: ["grep"],
    },
    {
      argv: ["sort", "--totally-unknown=1"],
      executableName: "sort",
      expected: false,
      name: "rejects unknown long options in safe-bin mode",
      resolvedPath: "/usr/bin/sort",
      safeBins: ["sort"],
    },
    {
      argv: ["sort", "--f=1"],
      executableName: "sort",
      expected: false,
      name: "rejects ambiguous long-option abbreviations in safe-bin mode",
      resolvedPath: "/usr/bin/sort",
      safeBins: ["sort"],
    },
    {
      argv: ["tr", "-S", "a", "b"],
      executableName: "tr",
      expected: false,
      name: "rejects unknown short options in safe-bin mode",
      resolvedPath: "/usr/bin/tr",
      safeBins: ["tr"],
    },
  ];

  it.runIf(process.platform !== "win32").each(cases)("$name", (testCase) => {
    const cwd = testCase.cwd ?? makeTempDir();
    testCase.setup?.(cwd);
    const executableName = testCase.executableName ?? "jq";
    const rawExecutable = testCase.rawExecutable ?? executableName;
    const ok = isSafeBinUsage({
      argv: testCase.argv,
      resolution: {
        executableName,
        rawExecutable,
        resolvedPath: testCase.resolvedPath,
      },
      safeBinProfiles: testCase.safeBinProfiles,
      safeBins: normalizeSafeBins(testCase.safeBins ?? [executableName]),
    });
    expect(ok).toBe(testCase.expected);
  });

  it("supports injected trusted safe-bin dirs for tests/callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const ok = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution: {
        executableName: "jq",
        rawExecutable: "jq",
        resolvedPath: "/custom/bin/jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
    });
    expect(ok).toBe(true);
  });

  it("supports injected platform for deterministic safe-bin checks", () => {
    const ok = isSafeBinUsage({
      argv: ["jq", ".foo"],
      platform: "win32",
      resolution: {
        executableName: "jq",
        rawExecutable: "jq",
        resolvedPath: "/usr/bin/jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
    });
    expect(ok).toBe(false);
  });

  it("supports injected trusted path checker for deterministic callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const baseParams = {
      argv: ["jq", ".foo"],
      resolution: {
        executableName: "jq",
        rawExecutable: "jq",
        resolvedPath: "/tmp/custom/jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
    };
    expect(
      isSafeBinUsage({
        ...baseParams,
        isTrustedSafeBinPathFn: () => true,
      }),
    ).toBe(true);
    expect(
      isSafeBinUsage({
        ...baseParams,
        isTrustedSafeBinPathFn: () => false,
      }),
    ).toBe(false);
  });

  it("keeps safe-bin profile fixtures aligned with compiled profiles", () => {
    for (const [name, fixture] of Object.entries(SAFE_BIN_PROFILE_FIXTURES)) {
      const profile = SAFE_BIN_PROFILES[name];
      expect(profile).toBeDefined();
      const fixtureDeniedFlags = fixture.deniedFlags ?? [];
      const compiledDeniedFlags = profile?.deniedFlags ?? new Set<string>();
      for (const deniedFlag of fixtureDeniedFlags) {
        expect(compiledDeniedFlags.has(deniedFlag)).toBe(true);
      }
      expect([...compiledDeniedFlags].toSorted()).toEqual(
        [...fixtureDeniedFlags].toSorted(),
      );
    }
  });

  it("does not include sort/grep in default safeBins", () => {
    const defaults = resolveSafeBins(undefined);
    expect(defaults.has("jq")).toBe(false);
    expect(defaults.has("sort")).toBe(false);
    expect(defaults.has("grep")).toBe(false);
  });

  it("does not auto-allow unprofiled safe-bin entries", () => {
    if (process.platform === "win32") {
      return;
    }
    const result = evaluateShellAllowlist({
      allowlist: [],
      command: "python3 -c \"print('owned')\"",
      cwd: "/tmp",
      safeBins: normalizeSafeBins(["python3"]),
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("allows caller-defined custom safe-bin profiles", () => {
    if (process.platform === "win32") {
      return;
    }
    const safeBinProfiles = resolveSafeBinProfiles({
      echo: {
        maxPositional: 1,
      },
    });
    const allow = isSafeBinUsage({
      argv: ["echo", "hello"],
      resolution: {
        executableName: "echo",
        rawExecutable: "echo",
        resolvedPath: "/bin/echo",
      },
      safeBinProfiles,
      safeBins: normalizeSafeBins(["echo"]),
    });
    const deny = isSafeBinUsage({
      argv: ["echo", "hello", "world"],
      resolution: {
        executableName: "echo",
        rawExecutable: "echo",
        resolvedPath: "/bin/echo",
      },
      safeBinProfiles,
      safeBins: normalizeSafeBins(["echo"]),
    });
    expect(allow).toBe(true);
    expect(deny).toBe(false);
  });

  it("blocks sort output flags independent of file existence", () => {
    if (process.platform === "win32") {
      return;
    }
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, "existing.txt"), "x");
    const resolution = {
      executableName: "sort",
      rawExecutable: "sort",
      resolvedPath: "/usr/bin/sort",
    };
    const safeBins = normalizeSafeBins(["sort"]);
    const existing = isSafeBinUsage({
      argv: ["sort", "-o", "existing.txt"],
      resolution,
      safeBins,
    });
    const missing = isSafeBinUsage({
      argv: ["sort", "-o", "missing.txt"],
      resolution,
      safeBins,
    });
    const longFlag = isSafeBinUsage({
      argv: ["sort", "--output=missing.txt"],
      resolution,
      safeBins,
    });
    expect(existing).toBe(false);
    expect(missing).toBe(false);
    expect(longFlag).toBe(false);
  });

  it("threads trusted safe-bin dirs through allowlist evaluation", () => {
    if (process.platform === "win32") {
      return;
    }
    const analysis = {
      ok: true as const,
      segments: [
        {
          argv: ["jq", ".foo"],
          raw: "jq .foo",
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              executableName: "jq",
              rawExecutable: "jq",
              resolvedPath: "/custom/bin/jq",
            }),
          }),
        },
      ],
    };
    const denied = evaluateExecAllowlist({
      allowlist: [],
      analysis,
      cwd: "/tmp",
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/usr/bin"]),
    });
    expect(denied.allowlistSatisfied).toBe(false);

    const allowed = evaluateExecAllowlist({
      allowlist: [],
      analysis,
      cwd: "/tmp",
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
    });
    expect(allowed.allowlistSatisfied).toBe(true);
  });

  it("does not auto-trust PATH-shadowed safe bins without explicit trusted dirs", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = makeTempDir();
    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeHead = path.join(fakeDir, "head");
    fs.writeFileSync(fakeHead, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeHead, 0o755);

    const result = evaluateShellAllowlist({
      allowlist: [],
      command: "head -n 1",
      cwd: tmp,
      env: makePathEnv(fakeDir),
      safeBins: normalizeSafeBins(["head"]),
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.execution.resolvedPath).toBe(fakeHead);
  });

  it("fails closed for semantic env wrappers in allowlist mode", () => {
    if (process.platform === "win32") {
      return;
    }
    const result = evaluateShellAllowlist({
      allowlist: [{ pattern: "/usr/bin/tr" }],
      command: "env -S 'sh -c \"echo pwned\"' tr",
      cwd: "/tmp",
      platform: process.platform,
      safeBins: normalizeSafeBins(["tr"]),
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.policyBlocked).toBe(true);
  });
});
