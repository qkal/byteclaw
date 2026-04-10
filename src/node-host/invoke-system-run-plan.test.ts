import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatExecCommand } from "../infra/system-run-command.js";
import {
  buildSystemRunApprovalPlan,
  hardenApprovedExecutionPaths,
  resolveMutableFileOperandSnapshotSync,
  revalidateApprovedMutableFileOperand,
} from "./invoke-system-run-plan.js";

interface PathTokenSetup {
  expected: string;
}

interface HardeningCase {
  name: string;
  mode: "build-plan" | "harden";
  argv: string[];
  shellCommand?: string | null;
  withPathToken?: boolean;
  expectedArgv: (ctx: { pathToken: PathTokenSetup | null }) => string[];
  expectedArgvChanged?: boolean;
  expectedCmdText?: string;
  checkRawCommandMatchesArgv?: boolean;
  expectedCommandPreview?: string | null;
}

interface ScriptOperandFixture {
  command: string[];
  scriptPath: string;
  initialBody: string;
  expectedArgvIndex: number;
}

interface RuntimeFixture {
  name: string;
  argv: string[];
  scriptName: string;
  initialBody: string;
  expectedArgvIndex: number;
  binName?: string;
  binNames?: string[];
  skipOnWin32?: boolean;
}

interface UnsafeRuntimeInvocationCase {
  name: string;
  binName: string;
  tmpPrefix: string;
  command: string[];
  setup?: (tmp: string) => void;
}

function createScriptOperandFixture(tmp: string, fixture?: RuntimeFixture): ScriptOperandFixture {
  if (fixture) {
    return {
      command: fixture.argv,
      expectedArgvIndex: fixture.expectedArgvIndex,
      initialBody: fixture.initialBody,
      scriptPath: path.join(tmp, fixture.scriptName),
    };
  }
  if (process.platform === "win32") {
    return {
      command: [process.execPath, "./run.js"],
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      scriptPath: path.join(tmp, "run.js"),
    };
  }
  return {
    command: ["/bin/sh", "./run.sh"],
    expectedArgvIndex: 1,
    initialBody: "#!/bin/sh\necho SAFE\n",
    scriptPath: path.join(tmp, "run.sh"),
  };
}

function writeFakeRuntimeBin(binDir: string, binName: string) {
  const runtimePath =
    process.platform === "win32" ? path.join(binDir, `${binName}.cmd`) : path.join(binDir, binName);
  const runtimeBody =
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, 0o755);
  }
}

function withFakeRuntimeBin<T>(params: { binName: string; run: () => T }): T {
  return withFakeRuntimeBins({
    binNames: [params.binName],
    run: params.run,
    tmpPrefix: `openclaw-${params.binName}-bin-`,
  });
}

function withFakeRuntimeBins<T>(params: {
  binNames: string[];
  tmpPrefix?: string;
  run: () => T;
}): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix ?? "openclaw-runtime-bins-"));
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const binName of params.binNames) {
    writeFakeRuntimeBin(binDir, binName);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  try {
    return params.run();
  } finally {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    fs.rmSync(tmp, { force: true, recursive: true });
  }
}

function expectMutableFileOperandApprovalPlan(fixture: ScriptOperandFixture, cwd: string) {
  const prepared = buildSystemRunApprovalPlan({
    command: fixture.command,
    cwd,
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error("unreachable");
  }
  expect(prepared.plan.mutableFileOperand).toEqual({
    argvIndex: fixture.expectedArgvIndex,
    path: fs.realpathSync(fixture.scriptPath),
    sha256: expect.any(String),
  });
}

function writeScriptOperandFixture(fixture: ScriptOperandFixture) {
  fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
  if (process.platform !== "win32") {
    fs.chmodSync(fixture.scriptPath, 0o755);
  }
}

function withScriptOperandPlanFixture<T>(
  params: {
    tmpPrefix: string;
    fixture?: RuntimeFixture;
    afterWrite?: (fixture: ScriptOperandFixture, tmp: string) => void;
  },
  run: (fixture: ScriptOperandFixture, tmp: string) => T,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix));
  const fixture = createScriptOperandFixture(tmp, params.fixture);
  writeScriptOperandFixture(fixture);
  params.afterWrite?.(fixture, tmp);
  try {
    return run(fixture, tmp);
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
}

const DENIED_RUNTIME_APPROVAL = {
  message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
  ok: false,
} as const;

function expectRuntimeApprovalDenied(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  expect(prepared).toEqual(DENIED_RUNTIME_APPROVAL);
}

function expectApprovalPlanWithoutMutableOperand(command: string[], cwd: string) {
  const prepared = buildSystemRunApprovalPlan({ command, cwd });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) {
    throw new Error("unreachable");
  }
  expect(prepared.plan.mutableFileOperand).toBeUndefined();
}

const unsafeRuntimeInvocationCases: UnsafeRuntimeInvocationCase[] = [
  {
    binName: "bun",
    command: ["bun", "run", "dev"],
    name: "rejects bun package script names that do not bind a concrete file",
    tmpPrefix: "openclaw-bun-package-script-",
  },
  {
    binName: "deno",
    command: ["deno", "eval", "console.log('SAFE')"],
    name: "rejects deno eval invocations that do not bind a concrete file",
    tmpPrefix: "openclaw-deno-eval-",
  },
  {
    binName: "tsx",
    command: ["tsx", "--eval", "console.log('SAFE')"],
    name: "rejects tsx eval invocations that do not bind a concrete file",
    tmpPrefix: "openclaw-tsx-eval-",
  },
  {
    binName: "node",
    command: ["node", "--import=./preload.mjs", "./main.mjs"],
    name: "rejects node inline import operands that cannot be bound to one stable file",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "main.mjs"), 'console.log("SAFE")\n');
      fs.writeFileSync(path.join(tmp, "preload.mjs"), 'console.log("SAFE")\n');
    },
    tmpPrefix: "openclaw-node-import-inline-",
  },
  {
    binName: "ruby",
    command: ["ruby", "-r", "attacker", "./safe.rb"],
    name: "rejects ruby require preloads that approval cannot bind completely",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.rb"), 'puts "SAFE"\n');
    },
    tmpPrefix: "openclaw-ruby-require-",
  },
  {
    binName: "ruby",
    command: ["ruby", "-I.", "./safe.rb"],
    name: "rejects ruby load-path flags that can redirect module resolution after approval",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.rb"), 'puts "SAFE"\n');
    },
    tmpPrefix: "openclaw-ruby-load-path-",
  },
  {
    binName: "perl",
    command: ["perl", "-MPreload", "./safe.pl"],
    name: "rejects perl module preloads that approval cannot bind completely",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
    tmpPrefix: "openclaw-perl-module-preload-",
  },
  {
    binName: "perl",
    command: ["perl", "-Ilib", "./safe.pl"],
    name: "rejects perl load-path flags that can redirect module resolution after approval",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
    tmpPrefix: "openclaw-perl-load-path-",
  },
  {
    binName: "perl",
    command: ["perl", "-Ilib", "-MPreload", "./safe.pl"],
    name: "rejects perl combined preload and load-path flags",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "safe.pl"), 'print "SAFE\\n";\n');
    },
    tmpPrefix: "openclaw-perl-preload-load-path-",
  },
  {
    binName: "node",
    command: ["sh", "-lc", "node ./run.js"],
    name: "rejects shell payloads that hide mutable interpreter scripts",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.js"), 'console.log("SAFE")\n');
    },
    tmpPrefix: "openclaw-inline-shell-node-",
  },
  {
    binName: "pnpm",
    command: ["pnpm", "dlx", "--future-flag", "tsx", "./run.ts"],
    name: "rejects pnpm dlx invocations with unrecognized flags that cannot be safely bound",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
    tmpPrefix: "openclaw-pnpm-dlx-unknown-flag-",
  },
  {
    binName: "pnpm",
    command: ["pnpm", "--future-flag", "dlx", "tsx", "./run.ts"],
    name: "rejects pnpm dlx invocations with unrecognized global flags before dlx when they hide a mutable script",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
    tmpPrefix: "openclaw-pnpm-dlx-unknown-prefix-",
  },
  {
    binName: "pnpm",
    command: ["pnpm", "--future-flag", "value", "dlx", "tsx", "./run.ts"],
    name: "rejects pnpm dlx invocations with unrecognized global flags that take a value before dlx",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
    tmpPrefix: "openclaw-pnpm-dlx-unknown-prefix-value-",
  },
  {
    binName: "pnpm",
    command: ["pnpm", "--", "dlx", "--future-flag", "tsx", "./run.ts"],
    name: "rejects pnpm dlx invocations with unrecognized flags after a global option terminator",
    setup: (tmp) => {
      fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE")\n');
    },
    tmpPrefix: "openclaw-pnpm-dlx-global-double-dash-",
  },
];

describe("hardenApprovedExecutionPaths", () => {
  const cases: HardeningCase[] = [
    {
      argv: ["env", "sh", "-c", "echo SAFE"],
      expectedArgv: () => ["env", "sh", "-c", "echo SAFE"],
      expectedCmdText: 'env sh -c "echo SAFE"',
      expectedCommandPreview: "echo SAFE",
      mode: "build-plan",
      name: "preserves shell-wrapper argv during approval hardening",
    },
    {
      argv: ["env", "tr", "a", "b"],
      expectedArgv: () => ["env", "tr", "a", "b"],
      expectedArgvChanged: false,
      mode: "harden",
      name: "preserves dispatch-wrapper argv during approval hardening",
      shellCommand: null,
    },
    {
      argv: ["poccmd", "SAFE"],
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "SAFE"],
      expectedArgvChanged: true,
      mode: "harden",
      name: "pins direct PATH-token executable during approval hardening",
      shellCommand: null,
      withPathToken: true,
    },
    {
      argv: ["env", "poccmd", "SAFE"],
      expectedArgv: () => ["env", "poccmd", "SAFE"],
      expectedArgvChanged: false,
      mode: "harden",
      name: "preserves env-wrapper PATH-token argv during approval hardening",
      shellCommand: null,
      withPathToken: true,
    },
    {
      argv: ["poccmd", "hello"],
      checkRawCommandMatchesArgv: true,
      expectedArgv: ({ pathToken }) => [pathToken!.expected, "hello"],
      expectedCommandPreview: null,
      mode: "build-plan",
      name: "rawCommand matches hardened argv after executable path pinning",
      withPathToken: true,
    },
    {
      argv: ["./env", "sh", "-c", "echo SAFE"],
      checkRawCommandMatchesArgv: true,
      expectedArgv: () => ["./env", "sh", "-c", "echo SAFE"],
      expectedCmdText: './env sh -c "echo SAFE"',
      expectedCommandPreview: "echo SAFE",
      mode: "build-plan",
      name: "stores full approval text and preview for path-qualified env wrappers",
    },
  ];

  it.runIf(process.platform !== "win32").each(cases)("$name", (testCase) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-hardening-"));
    const oldPath = process.env.PATH;
    let pathToken: PathTokenSetup | null = null;
    if (testCase.withPathToken) {
      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const link = path.join(binDir, "poccmd");
      fs.symlinkSync("/bin/echo", link);
      pathToken = { expected: fs.realpathSync(link) };
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    }
    try {
      if (testCase.mode === "build-plan") {
        const prepared = buildSystemRunApprovalPlan({
          command: testCase.argv,
          cwd: tmp,
        });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) {
          throw new Error("unreachable");
        }
        expect(prepared.plan.argv).toEqual(testCase.expectedArgv({ pathToken }));
        if (testCase.expectedCmdText) {
          expect(prepared.plan.commandText).toBe(testCase.expectedCmdText);
        }
        if (testCase.checkRawCommandMatchesArgv) {
          expect(prepared.plan.commandText).toBe(formatExecCommand(prepared.plan.argv));
        }
        if ("expectedCommandPreview" in testCase) {
          expect(prepared.plan.commandPreview ?? null).toBe(testCase.expectedCommandPreview);
        }
        return;
      }

      const hardened = hardenApprovedExecutionPaths({
        approvedByAsk: true,
        argv: testCase.argv,
        cwd: tmp,
        shellCommand: testCase.shellCommand ?? null,
      });
      expect(hardened.ok).toBe(true);
      if (!hardened.ok) {
        throw new Error("unreachable");
      }
      expect(hardened.argv).toEqual(testCase.expectedArgv({ pathToken }));
      if (typeof testCase.expectedArgvChanged === "boolean") {
        expect(hardened.argvChanged).toBe(testCase.expectedArgvChanged);
      }
    } finally {
      if (testCase.withPathToken) {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
      }
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  const mutableOperandCases: RuntimeFixture[] = [
    {
      argv: ["python3", "-B", "./run.py"],
      binName: "python3",
      expectedArgvIndex: 2,
      initialBody: 'print("SAFE")\n',
      name: "python flagged file",
      scriptName: "run.py",
    },
    {
      argv: ["lua", "./run.lua"],
      binName: "lua",
      expectedArgvIndex: 1,
      initialBody: 'print("SAFE")\n',
      name: "lua direct file",
      scriptName: "run.lua",
    },
    {
      argv: ["pypy", "./run.py"],
      binName: "pypy",
      expectedArgvIndex: 1,
      initialBody: 'print("SAFE")\n',
      name: "pypy direct file",
      scriptName: "run.py",
    },
    {
      argv: ["node20", "./run.js"],
      binName: "node20",
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      name: "versioned node alias file",
      scriptName: "run.js",
    },
    {
      argv: ["tsx", "./run.ts"],
      binName: "tsx",
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      name: "tsx direct file",
      scriptName: "run.ts",
    },
    {
      argv: ["jiti", "./run.ts"],
      binName: "jiti",
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      name: "jiti direct file",
      scriptName: "run.ts",
    },
    {
      argv: ["ts-node", "./run.ts"],
      binName: "ts-node",
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      name: "ts-node direct file",
      scriptName: "run.ts",
    },
    {
      argv: ["vite-node", "./run.ts"],
      binName: "vite-node",
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      name: "vite-node direct file",
      scriptName: "run.ts",
    },
    {
      argv: ["bun", "./run.ts"],
      binName: "bun",
      expectedArgvIndex: 1,
      initialBody: 'console.log("SAFE");\n',
      name: "bun direct file",
      scriptName: "run.ts",
    },
    {
      argv: ["bun", "run", "./run.ts"],
      binName: "bun",
      expectedArgvIndex: 2,
      initialBody: 'console.log("SAFE");\n',
      name: "bun run file",
      scriptName: "run.ts",
    },
    {
      argv: ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
      binName: "deno",
      expectedArgvIndex: 5,
      initialBody: 'console.log("SAFE");\n',
      name: "deno run file with flags",
      scriptName: "run.ts",
    },
    {
      argv: ["bun", "test", "./run.test.ts"],
      binName: "bun",
      expectedArgvIndex: 2,
      initialBody: 'console.log("SAFE");\n',
      name: "bun test file",
      scriptName: "run.test.ts",
    },
    {
      argv: ["deno", "test", "./run.test.ts"],
      binName: "deno",
      expectedArgvIndex: 2,
      initialBody: 'console.log("SAFE");\n',
      name: "deno test file",
      scriptName: "run.test.ts",
    },
    {
      argv: ["pnpm", "exec", "tsx", "./run.ts"],
      expectedArgvIndex: 3,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm exec tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--parallel", "exec", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm parallel exec tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "-w", "exec", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm workspace-root exec tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "-w", "dlx", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm workspace-root dlx tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "dlx", "tsx", "./run.ts"],
      expectedArgvIndex: 3,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm dlx tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--", "dlx", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm global double-dash dlx tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--package=tsx", "dlx", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm pre-dlx package-equals tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--reporter", "silent", "dlx", "--package", "tsx", "tsx", "./run.ts"],
      expectedArgvIndex: 7,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm reporter dlx package tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--reporter", "silent", "dlx", "-p", "tsx", "tsx", "./run.ts"],
      expectedArgvIndex: 7,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm reporter dlx short-package tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "dlx", "-s", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm silent dlx tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--reporter", "silent", "exec", "tsx", "./run.ts"],
      expectedArgvIndex: 5,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm reporter exec tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "--reporter=silent", "exec", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm reporter-equals exec tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["./pnpm.js", "exec", "tsx", "./run.ts"],
      expectedArgvIndex: 3,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm js shim exec tsx file",
      scriptName: "run.ts",
      skipOnWin32: true,
    },
    {
      argv: ["pnpm", "exec", "--", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm exec double-dash tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["pnpm", "node", "./run.js"],
      binNames: ["pnpm", "node"],
      expectedArgvIndex: 2,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm node file",
      scriptName: "run.js",
    },
    {
      argv: ["pnpm", "node", "--", "./run.js"],
      binNames: ["pnpm", "node"],
      expectedArgvIndex: 3,
      initialBody: 'console.log("SAFE");\n',
      name: "pnpm node double-dash file",
      scriptName: "run.js",
    },
    {
      argv: ["npx", "tsx", "./run.ts"],
      expectedArgvIndex: 2,
      initialBody: 'console.log("SAFE");\n',
      name: "npx tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["bunx", "tsx", "./run.ts"],
      expectedArgvIndex: 2,
      initialBody: 'console.log("SAFE");\n',
      name: "bunx tsx file",
      scriptName: "run.ts",
    },
    {
      argv: ["npm", "exec", "--", "tsx", "./run.ts"],
      expectedArgvIndex: 4,
      initialBody: 'console.log("SAFE");\n',
      name: "npm exec tsx file",
      scriptName: "run.ts",
    },
  ];

  it.each(mutableOperandCases)(
    "captures mutable $name operands in approval plans",
    (runtimeCase) => {
      if (runtimeCase.skipOnWin32 && process.platform === "win32") {
        return;
      }
      const binNames =
        runtimeCase.binNames ??
        (runtimeCase.binName ? [runtimeCase.binName] : ["bunx", "pnpm", "npm", "npx", "tsx"]);
      withFakeRuntimeBins({
        binNames,
        run: () => {
          withScriptOperandPlanFixture(
            {
              afterWrite: (fixture, tmp) => {
                const executablePath = fixture.command[0];
                if (executablePath?.endsWith("pnpm.js")) {
                  const shimPath = path.join(tmp, "pnpm.js");
                  fs.writeFileSync(shimPath, "#!/usr/bin/env node\nconsole.log('shim')\n");
                  fs.chmodSync(shimPath, 0o755);
                }
              },
              fixture: runtimeCase,
              tmpPrefix: "openclaw-approval-script-plan-",
            },
            (fixture, tmp) => {
              expectMutableFileOperandApprovalPlan(fixture, tmp);
            },
          );
        },
      });
    },
  );

  it("captures mutable shell script operands in approval plans", () => {
    withScriptOperandPlanFixture(
      {
        tmpPrefix: "openclaw-approval-script-plan-",
      },
      (fixture, tmp) => {
        expectMutableFileOperandApprovalPlan(fixture, tmp);
      },
    );
  });

  it.each(unsafeRuntimeInvocationCases)("$name", (testCase) => {
    withFakeRuntimeBin({
      binName: testCase.binName,
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), testCase.tmpPrefix));
        try {
          testCase.setup?.(tmp);
          expectRuntimeApprovalDenied(testCase.command, tmp);
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("detects rewritten script operands for pnpm dlx approval plans", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "tsx"],
      run: () => {
        withScriptOperandPlanFixture(
          {
            fixture: {
              argv: ["pnpm", "dlx", "tsx", "./run.ts"],
              expectedArgvIndex: 3,
              initialBody: 'console.log("SAFE");\n',
              name: "pnpm dlx rewritten script",
              scriptName: "run.ts",
            },
            tmpPrefix: "openclaw-pnpm-dlx-approval-",
          },
          (fixture, tmp) => {
            const prepared = buildSystemRunApprovalPlan({
              command: fixture.command,
              cwd: tmp,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }
            expect(prepared.plan.mutableFileOperand).toBeDefined();
            fs.writeFileSync(fixture.scriptPath, 'console.log("PWNED");\n');
            expect(
              revalidateApprovedMutableFileOperand({
                argv: prepared.plan.argv,
                cwd: prepared.plan.cwd ?? tmp,
                snapshot: prepared.plan.mutableFileOperand!,
              }),
            ).toBe(false);
          },
        );
      },
    });
  });

  it("does not bind pnpm dlx shell-mode commands to a mutable file operand", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "tsx"],
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-dlx-shell-mode-"));
        try {
          fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE");\n');
          expect(
            resolveMutableFileOperandSnapshotSync({
              argv: ["pnpm", "dlx", "--shell-mode", "tsx ./run.ts"],
              cwd: tmp,
              shellCommand: null,
            }),
          ).toEqual({ ok: true, snapshot: null });
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("allows pnpm dlx package binaries that do not bind a mutable local file", () => {
    withFakeRuntimeBin({
      binName: "pnpm",
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-dlx-package-bin-"));
        try {
          expectApprovalPlanWithoutMutableOperand(["pnpm", "dlx", "cowsay", "hello"], tmp);
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("allows pnpm dlx package binaries with data-like runtime names", () => {
    withFakeRuntimeBin({
      binName: "pnpm",
      run: () => {
        const tmp = fs.mkdtempSync(
          path.join(os.tmpdir(), "openclaw-pnpm-dlx-package-runtime-token-"),
        );
        try {
          expectApprovalPlanWithoutMutableOperand(["pnpm", "dlx", "cowsay", "node"], tmp);
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("allows pnpm dlx package binaries with multi-token data-like runtime names", () => {
    withFakeRuntimeBin({
      binName: "pnpm",
      run: () => {
        const tmp = fs.mkdtempSync(
          path.join(os.tmpdir(), "openclaw-pnpm-dlx-package-runtime-token-multi-"),
        );
        try {
          expectApprovalPlanWithoutMutableOperand(["pnpm", "dlx", "cowsay", "node", "hello"], tmp);
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("allows pnpm dlx package binaries with local file arguments", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "eslint"],
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-dlx-package-file-"));
        try {
          fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
          fs.writeFileSync(path.join(tmp, "src", "index.ts"), 'console.log("SAFE");\n');
          expectApprovalPlanWithoutMutableOperand(["pnpm", "dlx", "eslint", "src/index.ts"], tmp);
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("allows pnpm dlx package binaries with interpreter-like data tails", () => {
    withFakeRuntimeBin({
      binName: "pnpm",
      run: () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-dlx-package-data-tail-"));
        try {
          fs.writeFileSync(path.join(tmp, "run.ts"), 'console.log("SAFE");\n');
          expectApprovalPlanWithoutMutableOperand(
            ["pnpm", "dlx", "cowsay", "tsx", "./run.ts"],
            tmp,
          );
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
    });
  });

  it("treats -- as the end of pnpm dlx option parsing", () => {
    withFakeRuntimeBins({
      binNames: ["pnpm", "tsx"],
      run: () => {
        withScriptOperandPlanFixture(
          {
            fixture: {
              argv: ["pnpm", "dlx", "--", "tsx", "./run.ts"],
              expectedArgvIndex: 4,
              initialBody: 'console.log("SAFE");\n',
              name: "pnpm dlx double dash",
              scriptName: "run.ts",
            },
            tmpPrefix: "openclaw-pnpm-dlx-double-dash-",
          },
          (fixture, tmp) => {
            expectMutableFileOperandApprovalPlan(fixture, tmp);
          },
        );
      },
    });
  });

  it("captures the real shell script operand after value-taking shell flags", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-option-value-"));
    try {
      const scriptPath = path.join(tmp, "run.sh");
      fs.writeFileSync(scriptPath, "#!/bin/sh\necho SAFE\n");
      fs.writeFileSync(path.join(tmp, "errexit"), "decoy\n");
      const snapshot = resolveMutableFileOperandSnapshotSync({
        argv: ["/bin/bash", "-o", "errexit", "./run.sh"],
        cwd: tmp,
        shellCommand: null,
      });
      expect(snapshot).toEqual({
        ok: true,
        snapshot: {
          argvIndex: 3,
          path: fs.realpathSync(scriptPath),
          sha256: expect.any(String),
        },
      });
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
