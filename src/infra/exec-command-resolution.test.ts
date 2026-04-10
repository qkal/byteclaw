import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makePathEnv, makeTempDir } from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  normalizeSafeBins,
  parseExecArgvToken,
  resolveAllowlistCandidatePath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecutionTargetCandidatePath,
  resolvePlannedSegmentArgv,
  resolvePolicyTargetCandidatePath,
} from "./exec-approvals.js";

function buildNestedEnvShellCommand(params: {
  envExecutable: string;
  depth: number;
  payload: string;
}): string[] {
  return [...Array(params.depth).fill(params.envExecutable), "/bin/sh", "-c", params.payload];
}

function analyzeEnvWrapperAllowlist(params: { argv: string[]; envPath: string; cwd: string }) {
  const analysis = {
    ok: true as const,
    segments: [
      {
        argv: params.argv,
        raw: params.argv.join(" "),
        resolution: resolveCommandResolutionFromArgv(
          params.argv,
          params.cwd,
          makePathEnv(params.envPath),
        ),
      },
    ],
  };
  const allowlistEval = evaluateExecAllowlist({
    allowlist: [{ pattern: params.envPath }],
    analysis,
    cwd: params.cwd,
    safeBins: normalizeSafeBins([]),
  });
  return { allowlistEval, analysis };
}

function createPathExecutableFixture(params?: { executable?: string }): {
  exeName: string;
  exePath: string;
  binDir: string;
} {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const baseName = params?.executable ?? "rg";
  const exeName = process.platform === "win32" ? `${baseName}.exe` : baseName;
  const exePath = path.join(binDir, exeName);
  fs.writeFileSync(exePath, "");
  fs.chmodSync(exePath, 0o755);
  return { binDir, exeName, exePath };
}

function expectResolutionPathCase(params: {
  name: string;
  resolution: ReturnType<typeof resolveCommandResolution>;
  cwd?: string;
  expectedExecutionPath: string;
  expectedPolicyPath?: string;
  expectedExecutableName?: string;
}): void {
  expect(
    resolveExecutionTargetCandidatePath(params.resolution ?? null, params.cwd),
    `${params.name} execution`,
  ).toBe(params.expectedExecutionPath);
  if (params.expectedPolicyPath !== undefined) {
    expect(
      resolvePolicyTargetCandidatePath(params.resolution ?? null, params.cwd),
      `${params.name} policy`,
    ).toBe(params.expectedPolicyPath);
  }
  if (params.expectedExecutableName) {
    expect(params.resolution?.execution.executableName, params.name).toBe(
      params.expectedExecutableName,
    );
  }
}

interface CommandResolutionFixture {
  command: string;
  cwd?: string;
  envPath?: NodeJS.ProcessEnv;
  expectedExecutionPath: string;
  expectedExecutableName?: string;
}

describe("exec-command-resolution", () => {
  it.each([
    {
      name: "PATH executable",
      setup: (): CommandResolutionFixture => {
        const fixture = createPathExecutableFixture();
        return {
          command: "rg -n foo",
          cwd: undefined,
          envPath: makePathEnv(fixture.binDir),
          expectedExecutableName: fixture.exeName,
          expectedExecutionPath: fixture.exePath,
        };
      },
    },
    {
      name: "relative executable",
      setup: (): CommandResolutionFixture => {
        const dir = makeTempDir();
        const cwd = path.join(dir, "project");
        const scriptName = process.platform === "win32" ? "run.cmd" : "run.sh";
        const script = path.join(cwd, "scripts", scriptName);
        fs.mkdirSync(path.dirname(script), { recursive: true });
        fs.writeFileSync(script, "");
        fs.chmodSync(script, 0o755);
        return {
          command: `./scripts/${scriptName} --flag`,
          cwd,
          envPath: undefined,
          expectedExecutionPath: script,
        };
      },
    },
    {
      name: "quoted executable",
      setup: (): CommandResolutionFixture => {
        const dir = makeTempDir();
        const cwd = path.join(dir, "project");
        const scriptName = process.platform === "win32" ? "tool.cmd" : "tool";
        const script = path.join(cwd, "bin", scriptName);
        fs.mkdirSync(path.dirname(script), { recursive: true });
        fs.writeFileSync(script, "");
        fs.chmodSync(script, 0o755);
        return {
          command: `"./bin/${scriptName}" --version`,
          cwd,
          envPath: undefined,
          expectedExecutionPath: script,
        };
      },
    },
  ])("resolves $name", ({ setup }) => {
    const params = setup();
    expectResolutionPathCase({
      cwd: params.cwd,
      expectedExecutableName: params.expectedExecutableName,
      expectedExecutionPath: params.expectedExecutionPath,
      name: params.command,
      resolution: resolveCommandResolution(params.command, params.cwd, params.envPath),
    });
  });

  it("unwraps transparent env and nice wrappers to the effective executable", () => {
    const fixture = createPathExecutableFixture();

    const envResolution = resolveCommandResolutionFromArgv(
      ["/usr/bin/env", "rg", "-n", "needle"],
      undefined,
      makePathEnv(fixture.binDir),
    );
    expect(envResolution?.execution.resolvedPath).toBe(fixture.exePath);
    expect(envResolution?.execution.executableName).toBe(fixture.exeName);

    const niceResolution = resolveCommandResolutionFromArgv([
      "/usr/bin/nice",
      "bash",
      "-lc",
      "echo hi",
    ]);
    expect(niceResolution?.execution.rawExecutable).toBe("bash");
    expect(niceResolution?.execution.executableName.toLowerCase()).toContain("bash");

    const timeResolution = resolveCommandResolutionFromArgv(
      ["/usr/bin/time", "-p", "rg", "-n", "needle"],
      undefined,
      makePathEnv(fixture.binDir),
    );
    expect(timeResolution?.execution.resolvedPath).toBe(fixture.exePath);
    expect(timeResolution?.execution.executableName).toBe(fixture.exeName);
  });

  it("keeps shell multiplexer wrappers as a separate policy target", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = path.join(dir, "busybox");
    fs.writeFileSync(busybox, "");
    fs.chmodSync(busybox, 0o755);

    const resolution = resolveCommandResolutionFromArgv([busybox, "sh", "-lc", "echo hi"]);
    expect(resolution?.execution.rawExecutable).toBe("sh");
    expect(resolution?.effectiveArgv).toEqual(["sh", "-lc", "echo hi"]);
    expect(resolution?.wrapperChain).toEqual(["busybox"]);
    expect(resolution?.policy.rawExecutable).toBe(busybox);
    expect(resolution?.policy.resolvedPath).toBe(busybox);
    expect(resolvePolicyTargetCandidatePath(resolution ?? null, dir)).toBe(busybox);
    expect(resolution?.execution.executableName.toLowerCase()).toContain("sh");
  });

  it("does not satisfy inner-shell allowlists when invoked through busybox wrappers", () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir();
    const busybox = path.join(dir, "busybox");
    fs.writeFileSync(busybox, "");
    fs.chmodSync(busybox, 0o755);

    const shellResolution = resolveCommandResolutionFromArgv(["sh", "-lc", "echo hi"]);
    expect(shellResolution?.execution.resolvedPath).toBeTruthy();

    const wrappedResolution = resolveCommandResolutionFromArgv([busybox, "sh", "-lc", "echo hi"]);
    const evalResult = evaluateExecAllowlist({
      allowlist: [{ pattern: shellResolution?.execution.resolvedPath ?? "" }],
      analysis: {
        ok: true,
        segments: [
          {
            argv: [busybox, "sh", "-lc", "echo hi"],
            raw: `${busybox} sh -lc echo hi`,
            resolution: wrappedResolution,
          },
        ],
      },
      cwd: dir,
      safeBins: normalizeSafeBins([]),
    });

    expect(evalResult.allowlistSatisfied).toBe(false);
  });

  it("blocks semantic env wrappers, env -S, and deep transparent-wrapper chains", () => {
    const blockedEnv = resolveCommandResolutionFromArgv([
      "/usr/bin/env",
      "FOO=bar",
      "rg",
      "-n",
      "needle",
    ]);
    expect(blockedEnv?.policyBlocked).toBe(true);
    expect(blockedEnv?.execution.rawExecutable).toBe("/usr/bin/env");

    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const envPath = path.join(binDir, "env");
    fs.writeFileSync(envPath, "#!/bin/sh\n");
    fs.chmodSync(envPath, 0o755);

    const envS = analyzeEnvWrapperAllowlist({
      argv: [envPath, "-S", 'sh -c "echo pwned"'],
      cwd: dir,
      envPath,
    });
    expect(envS.analysis.segments[0]?.resolution?.policyBlocked).toBe(true);
    expect(envS.allowlistEval.allowlistSatisfied).toBe(false);

    const deep = analyzeEnvWrapperAllowlist({
      argv: buildNestedEnvShellCommand({
        depth: 5,
        envExecutable: envPath,
        payload: "echo pwned",
      }),
      cwd: dir,
      envPath,
    });
    expect(deep.analysis.segments[0]?.resolution?.policyBlocked).toBe(true);
    expect(deep.analysis.segments[0]?.resolution?.blockedWrapper).toBe("env");
    expect(deep.allowlistEval.allowlistSatisfied).toBe(false);
  });

  it("resolves allowlist candidate paths from unresolved raw executables", () => {
    expect(
      resolveExecutionTargetCandidatePath(
        {
          executableName: "tool",
          rawExecutable: "~/bin/tool",
        },
        "/tmp",
      ),
    ).toContain("/bin/tool");

    expect(
      resolveExecutionTargetCandidatePath(
        {
          executableName: "run.sh",
          rawExecutable: "./scripts/run.sh",
        },
        "/repo",
      ),
    ).toBe(path.resolve("/repo", "./scripts/run.sh"));

    expect(
      resolveExecutionTargetCandidatePath(
        {
          executableName: "rg",
          rawExecutable: "rg",
        },
        "/repo",
      ),
    ).toBeUndefined();
  });

  it.runIf(process.platform !== "win32").each([
    {
      allowlistPatternFactory: ({ rgPath }: { rgPath: string }) => rgPath,
      allowlistSatisfied: true,
      argvFactory: ({ envPath }: { envPath: string }) => [envPath, "rg", "-n", "needle"],
      envFactory: ({ binDir }: { binDir: string }) => makePathEnv(binDir),
      expectedExecutionPathFactory: ({ rgPath }: { rgPath: string }) => rgPath,
      expectedPlannedArgvFactory: ({ rgPath }: { rgPath: string }) => [
        fs.realpathSync(rgPath),
        "-n",
        "needle",
      ],
      expectedPolicyPathFactory: ({ rgPath }: { rgPath: string }) => rgPath,
      name: "transparent env wrapper",
    },
    {
      allowlistPatternFactory: ({ busybox }: { busybox: string }) => busybox,
      allowlistSatisfied: true,
      argvFactory: ({ busybox }: { busybox: string }) => [busybox, "sh", "-lc", "echo hi"],
      envFactory: ({ binDir }: { binDir: string }) => ({
        PATH: `${binDir}${path.delimiter}/bin:/usr/bin`,
      }),
      expectedExecutionPathFactory: () => "/bin/sh",
      expectedPlannedArgvFactory: () => [fs.realpathSync("/bin/sh"), "-lc", "echo hi"],
      expectedPolicyPathFactory: ({ busybox }: { busybox: string }) => busybox,
      name: "busybox shell multiplexer",
    },
    {
      allowlistPatternFactory: ({ envPath }: { envPath: string }) => envPath,
      allowlistSatisfied: false,
      argvFactory: ({ envPath }: { envPath: string }) => [envPath, "FOO=bar", "rg", "-n", "needle"],
      envFactory: ({ binDir }: { binDir: string }) => makePathEnv(binDir),
      expectedExecutionPathFactory: ({ envPath }: { envPath: string }) => envPath,
      expectedPlannedArgvFactory: () => null,
      expectedPolicyPathFactory: ({ envPath }: { envPath: string }) => envPath,
      name: "semantic env wrapper",
    },
    {
      allowlistPatternFactory: ({ envPath }: { envPath: string }) => envPath,
      allowlistSatisfied: false,
      argvFactory: ({ envPath }: { envPath: string }) =>
        buildNestedEnvShellCommand({
          depth: 5,
          envExecutable: envPath,
          payload: "echo hi",
        }),
      envFactory: ({ binDir }: { binDir: string }) => makePathEnv(binDir),
      expectedExecutionPathFactory: ({ envPath }: { envPath: string }) => envPath,
      expectedPlannedArgvFactory: () => null,
      expectedPolicyPathFactory: ({ envPath }: { envPath: string }) => envPath,
      name: "wrapper depth overflow",
    },
  ] as const)(
    "keeps execution and policy targets coherent across wrapper classes: $name",
    (testCase) => {
      const dir = makeTempDir();
      const binDir = path.join(dir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const envPath = path.join(binDir, "env");
      const rgPath = path.join(binDir, "rg");
      const busybox = path.join(dir, "busybox");
      for (const file of [envPath, rgPath, busybox]) {
        fs.writeFileSync(file, "");
        fs.chmodSync(file, 0o755);
      }
      const fixture = { binDir, busybox, envPath, rgPath } as const;
      const argv = [...testCase.argvFactory(fixture)];
      const env = testCase.envFactory(fixture);
      const resolution = resolveCommandResolutionFromArgv(argv, dir, env);
      const segment = {
        argv,
        raw: argv.join(" "),
        resolution,
      };
      expectResolutionPathCase({
        cwd: dir,
        expectedExecutionPath: testCase.expectedExecutionPathFactory(fixture),
        expectedPolicyPath: testCase.expectedPolicyPathFactory(fixture),
        name: testCase.name,
        resolution,
      });
      expect(resolvePlannedSegmentArgv(segment), `${testCase.name} planned argv`).toEqual(
        testCase.expectedPlannedArgvFactory(fixture),
      );
      const evaluation = evaluateExecAllowlist({
        allowlist: [{ pattern: testCase.allowlistPatternFactory(fixture) }],
        analysis: { ok: true, segments: [segment] },
        cwd: dir,
        env,
        safeBins: normalizeSafeBins([]),
      });
      expect(evaluation.allowlistSatisfied, `${testCase.name} allowlist`).toBe(
        testCase.allowlistSatisfied,
      );
    },
  );

  it("normalizes argv tokens for short clusters, long options, and special sentinels", () => {
    expect(parseExecArgvToken("")).toEqual({ kind: "empty", raw: "" });
    expect(parseExecArgvToken("--")).toEqual({ kind: "terminator", raw: "--" });
    expect(parseExecArgvToken("-")).toEqual({ kind: "stdin", raw: "-" });
    expect(parseExecArgvToken("echo")).toEqual({ kind: "positional", raw: "echo" });

    const short = parseExecArgvToken("-oblocked.txt");
    expect(short.kind).toBe("option");
    if (short.kind === "option" && short.style === "short-cluster") {
      expect(short.flags[0]).toBe("-o");
      expect(short.cluster).toBe("oblocked.txt");
    }

    const long = parseExecArgvToken("--output=blocked.txt");
    expect(long.kind).toBe("option");
    if (long.kind === "option" && long.style === "long") {
      expect(long.flag).toBe("--output");
      expect(long.inlineValue).toBe("blocked.txt");
    }
  });

  it("does not synthesize cwd-joined allowlist candidates from drive-less windows roots", () => {
    if (process.platform !== "win32") {
      return;
    }

    expect(
      resolveAllowlistCandidatePath(
        {
          executableName: "openclaw",
          rawExecutable: String.raw`:\Users\demo\AI\system\openclaw`,
        },
        String.raw`C:\Users\demo\AI\system\openclaw`,
      ),
    ).toBeUndefined();
    expect(
      resolveAllowlistCandidatePath(
        {
          executableName: "openclaw",
          rawExecutable: String.raw`:/Users/demo/AI/system/openclaw`,
        },
        String.raw`C:\Users\demo\AI\system\openclaw`,
      ),
    ).toBeUndefined();
  });
});
