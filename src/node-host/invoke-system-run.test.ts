import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { loadExecApprovals, saveExecApprovals } from "../infra/exec-approvals.js";
import type { ExecHostResponse } from "../infra/exec-host.js";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import { formatSystemRunAllowlistMissMessage, handleSystemRunInvoke } from "./invoke-system-run.js";
import type { HandleSystemRunInvokeOptions } from "./invoke-system-run.js";

type MockedRunCommand = Mock<HandleSystemRunInvokeOptions["runCommand"]>;
type MockedRunViaMacAppExecHost = Mock<HandleSystemRunInvokeOptions["runViaMacAppExecHost"]>;
type MockedSendInvokeResult = Mock<HandleSystemRunInvokeOptions["sendInvokeResult"]>;
type MockedSendExecFinishedEvent = Mock<HandleSystemRunInvokeOptions["sendExecFinishedEvent"]>;
type MockedSendNodeEvent = Mock<HandleSystemRunInvokeOptions["sendNodeEvent"]>;

describe("formatSystemRunAllowlistMissMessage", () => {
  it("returns legacy allowlist miss message by default", () => {
    expect(formatSystemRunAllowlistMissMessage()).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("adds Windows shell-wrapper guidance when blocked by cmd.exe policy", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        windowsShellWrapperBlocked: true,
      }),
    ).toContain("Windows shell wrappers like cmd.exe /c require approval");
  });
});

describe("handleSystemRunInvoke mac app exec host routing", () => {
  let testOpenClawHome = "";
  let previousOpenClawHome: string | undefined;

  beforeEach(() => {
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    testOpenClawHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-host-home-"));
    process.env.OPENCLAW_HOME = testOpenClawHome;
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    if (testOpenClawHome) {
      fs.rmSync(testOpenClawHome, { force: true, recursive: true });
      testOpenClawHome = "";
    }
  });

  function createLocalRunResult(stdout = "local-ok") {
    return {
      error: null,
      exitCode: 0,
      stderr: "",
      stdout,
      success: true,
      timedOut: false,
      truncated: false,
    };
  }

  function createTempExecutable(params: { dir: string; name: string }): string {
    const fileName = process.platform === "win32" ? `${params.name}.exe` : params.name;
    const executablePath = path.join(params.dir, fileName);
    fs.writeFileSync(executablePath, "");
    fs.chmodSync(executablePath, 0o755);
    return executablePath;
  }

  function expectInvokeOk(
    sendInvokeResult: MockedSendInvokeResult,
    params?: { payloadContains?: string },
  ) {
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        ...(params?.payloadContains
          ? { payloadJSON: expect.stringContaining(params.payloadContains) }
          : {}),
      }),
    );
  }

  function expectInvokeErrorMessage(
    sendInvokeResult: MockedSendInvokeResult,
    params: { message: string; exact?: boolean },
  ) {
    expect(sendInvokeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: params.exact ? params.message : expect.stringContaining(params.message),
        }),
        ok: false,
      }),
    );
  }

  function expectApprovalRequiredDenied(params: {
    sendNodeEvent: MockedSendNodeEvent;
    sendInvokeResult: MockedSendInvokeResult;
  }) {
    expect(params.sendNodeEvent).toHaveBeenCalledWith(
      expect.anything(),
      "exec.denied",
      expect.objectContaining({ reason: "approval-required" }),
    );
    expectInvokeErrorMessage(params.sendInvokeResult, {
      exact: true,
      message: "SYSTEM_RUN_DENIED: approval required",
    });
  }

  function createMutableScriptOperandFixture(tmp: string): {
    command: string[];
    scriptPath: string;
    initialBody: string;
    changedBody: string;
  } {
    if (process.platform === "win32") {
      const scriptPath = path.join(tmp, "run.js");
      return {
        changedBody: 'console.log("PWNED");\n',
        command: [process.execPath, "./run.js"],
        initialBody: 'console.log("SAFE");\n',
        scriptPath,
      };
    }
    const scriptPath = path.join(tmp, "run.sh");
    return {
      changedBody: "#!/bin/sh\necho PWNED\n",
      command: ["/bin/sh", "./run.sh"],
      initialBody: "#!/bin/sh\necho SAFE\n",
      scriptPath,
    };
  }

  function createRuntimeScriptOperandFixture(params: {
    tmp: string;
    runtime: "bun" | "deno" | "jiti" | "tsx";
  }): {
    command: string[];
    scriptPath: string;
    initialBody: string;
    changedBody: string;
  } {
    const scriptPath = path.join(params.tmp, "run.ts");
    const initialBody = 'console.log("SAFE");\n';
    const changedBody = 'console.log("PWNED");\n';
    switch (params.runtime) {
      case "bun": {
        return {
          changedBody,
          command: ["bun", "run", "./run.ts"],
          initialBody,
          scriptPath,
        };
      }
      case "deno": {
        return {
          changedBody,
          command: ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
          initialBody,
          scriptPath,
        };
      }
      case "jiti": {
        return {
          changedBody,
          command: ["jiti", "./run.ts"],
          initialBody,
          scriptPath,
        };
      }
      case "tsx": {
        return {
          changedBody,
          command: ["tsx", "./run.ts"],
          initialBody,
          scriptPath,
        };
      }
    }
    const unsupportedRuntime: never = params.runtime;
    throw new Error(`unsupported runtime fixture: ${String(unsupportedRuntime)}`);
  }

  function buildNestedEnvShellCommand(params: { depth: number; payload: string }): string[] {
    return [...Array(params.depth).fill("/usr/bin/env"), "/bin/sh", "-c", params.payload];
  }

  function createMacExecHostSuccess(stdout = "app-ok"): ExecHostResponse {
    return {
      ok: true,
      payload: {
        error: null,
        exitCode: 0,
        stderr: "",
        stdout,
        success: true,
        timedOut: false,
      },
    };
  }

  function createAllowlistOnMissApprovals(params?: {
    autoAllowSkills?: boolean;
    agents?: Parameters<typeof saveExecApprovals>[0]["agents"];
  }): Parameters<typeof saveExecApprovals>[0] {
    return {
      agents: params?.agents ?? {},
      defaults: {
        ask: "on-miss",
        askFallback: "deny",
        security: "allowlist",
        ...(params?.autoAllowSkills ? { autoAllowSkills: true } : {}),
      },
      version: 1,
    };
  }

  function createInvokeSpies(params?: { runCommand?: MockedRunCommand }): {
    runCommand: MockedRunCommand;
    sendInvokeResult: MockedSendInvokeResult;
    sendNodeEvent: MockedSendNodeEvent;
  } {
    return {
      runCommand: params?.runCommand ?? vi.fn(async () => createLocalRunResult()),
      sendInvokeResult: vi.fn(async () => {}),
      sendNodeEvent: vi.fn(async () => {}),
    };
  }

  async function withTempApprovalsHome<T>(params: {
    approvals: Parameters<typeof saveExecApprovals>[0];
    run: (ctx: { tempHome: string }) => Promise<T>;
  }): Promise<T> {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = tempHome;
    saveExecApprovals(params.approvals);
    try {
      return await params.run({ tempHome });
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      fs.rmSync(tempHome, { force: true, recursive: true });
    }
  }

  async function withPathTokenCommand<T>(params: {
    tmpPrefix: string;
    run: (ctx: { link: string; expected: string }) => Promise<T>;
  }): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix));
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "poccmd");
    fs.symlinkSync("/bin/echo", link);
    const expected = fs.realpathSync(link);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      return await params.run({ expected, link });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  }

  async function withFakeRuntimeOnPath<T>(params: {
    runtime: "bun" | "deno" | "jiti" | "tsx";
    run: () => Promise<T>;
  }): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${params.runtime}-path-`));
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const runtimePath =
      process.platform === "win32"
        ? path.join(binDir, `${params.runtime}.cmd`)
        : path.join(binDir, params.runtime);
    const runtimeBody =
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
    fs.writeFileSync(runtimePath, runtimeBody, { mode: 0o755 });
    if (process.platform !== "win32") {
      fs.chmodSync(runtimePath, 0o755);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
    try {
      return await params.run();
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  }

  function expectCommandPinnedToCanonicalPath(params: {
    runCommand: MockedRunCommand;
    expected: string;
    commandTail: string[];
    cwd?: string;
  }) {
    expect(params.runCommand).toHaveBeenCalledWith(
      [params.expected, ...params.commandTail],
      params.cwd,
      undefined,
      undefined,
    );
  }

  function resolveStatTargetPath(target: string | Buffer | URL | number): string {
    if (typeof target === "string") {
      return path.resolve(target);
    }
    if (Buffer.isBuffer(target)) {
      return path.resolve(target.toString());
    }
    if (target instanceof URL) {
      return path.resolve(target.pathname);
    }
    return path.resolve(String(target));
  }

  async function withMockedCwdIdentityDrift<T>(params: {
    canonicalCwd: string;
    driftDir: string;
    stableHitsBeforeDrift?: number;
    run: () => Promise<T>;
  }): Promise<T> {
    const stableHitsBeforeDrift = params.stableHitsBeforeDrift ?? 2;
    const realStatSync = fs.statSync.bind(fs);
    const baselineStat = realStatSync(params.canonicalCwd);
    const driftStat = realStatSync(params.driftDir);
    let canonicalHits = 0;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const resolvedTarget = resolveStatTargetPath(args[0]);
      if (resolvedTarget === params.canonicalCwd) {
        canonicalHits += 1;
        if (canonicalHits > stableHitsBeforeDrift) {
          return driftStat;
        }
        return baselineStat;
      }
      return realStatSync(...args);
    });
    try {
      return await params.run();
    } finally {
      statSpy.mockRestore();
    }
  }

  async function runSystemInvoke(params: {
    preferMacAppExecHost: boolean;
    runViaResponse?: ExecHostResponse | null;
    command?: string[];
    env?: Record<string, string>;
    rawCommand?: string | null;
    systemRunPlan?: SystemRunApprovalPlan | null;
    cwd?: string;
    security?: "full" | "allowlist";
    ask?: "off" | "on-miss" | "always";
    approvalDecision?: "allow" | "allow-always" | "deny" | null;
    approved?: boolean;
    runCommand?: HandleSystemRunInvokeOptions["runCommand"];
    runViaMacAppExecHost?: HandleSystemRunInvokeOptions["runViaMacAppExecHost"];
    sendInvokeResult?: HandleSystemRunInvokeOptions["sendInvokeResult"];
    sendExecFinishedEvent?: HandleSystemRunInvokeOptions["sendExecFinishedEvent"];
    sendNodeEvent?: HandleSystemRunInvokeOptions["sendNodeEvent"];
    skillBinsCurrent?: () => Promise<{ name: string; resolvedPath: string }[]>;
    isCmdExeInvocation?: HandleSystemRunInvokeOptions["isCmdExeInvocation"];
  }): Promise<{
    runCommand: MockedRunCommand;
    runViaMacAppExecHost: MockedRunViaMacAppExecHost;
    sendInvokeResult: MockedSendInvokeResult;
    sendNodeEvent: MockedSendNodeEvent;
    sendExecFinishedEvent: MockedSendExecFinishedEvent;
  }> {
    const runCommand: MockedRunCommand = vi.fn<HandleSystemRunInvokeOptions["runCommand"]>(
      async () => createLocalRunResult(),
    );
    const runViaMacAppExecHost: MockedRunViaMacAppExecHost = vi.fn<
      HandleSystemRunInvokeOptions["runViaMacAppExecHost"]
    >(async () => params.runViaResponse ?? null);
    const sendInvokeResult: MockedSendInvokeResult = vi.fn<
      HandleSystemRunInvokeOptions["sendInvokeResult"]
    >(async () => {});
    const sendNodeEvent: MockedSendNodeEvent = vi.fn<HandleSystemRunInvokeOptions["sendNodeEvent"]>(
      async () => {},
    );
    const sendExecFinishedEvent: MockedSendExecFinishedEvent = vi.fn<
      HandleSystemRunInvokeOptions["sendExecFinishedEvent"]
    >(async () => {});

    if (params.runCommand !== undefined) {
      runCommand.mockImplementation(params.runCommand);
    }
    if (params.runViaMacAppExecHost !== undefined) {
      runViaMacAppExecHost.mockImplementation(params.runViaMacAppExecHost);
    }
    if (params.sendInvokeResult !== undefined) {
      sendInvokeResult.mockImplementation(params.sendInvokeResult);
    }
    if (params.sendNodeEvent !== undefined) {
      sendNodeEvent.mockImplementation(params.sendNodeEvent);
    }
    if (params.sendExecFinishedEvent !== undefined) {
      sendExecFinishedEvent.mockImplementation(params.sendExecFinishedEvent);
    }

    await handleSystemRunInvoke({
      buildExecEventPayload: (payload) => payload,
      client: {} as never,
      execHostEnforced: false,
      execHostFallbackAllowed: true,
      isCmdExeInvocation: params.isCmdExeInvocation ?? (() => false),
      params: {
        approvalDecision: params.approvalDecision,
        approved: params.approved ?? false,
        command: params.command ?? ["echo", "ok"],
        cwd: params.cwd,
        env: params.env,
        rawCommand: params.rawCommand,
        sessionKey: "agent:main:main",
        systemRunPlan: params.systemRunPlan,
      },
      preferMacAppExecHost: params.preferMacAppExecHost,
      resolveExecAsk: () => params.ask ?? "off",
      resolveExecSecurity: () => params.security ?? "full",
      runCommand,
      runViaMacAppExecHost,
      sanitizeEnv: () => undefined,
      sendExecFinishedEvent,
      sendInvokeResult,
      sendNodeEvent,
      skillBins: {
        current: params.skillBinsCurrent ?? (async () => []),
      },
    });

    return {
      runCommand,
      runViaMacAppExecHost,
      sendExecFinishedEvent,
      sendInvokeResult,
      sendNodeEvent,
    };
  }

  it("uses local execution by default when mac app exec host preference is disabled", async () => {
    const { runCommand, runViaMacAppExecHost, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: false,
    });

    expect(runViaMacAppExecHost).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expectInvokeOk(sendInvokeResult, { payloadContains: "local-ok" });
  });

  it("uses mac app exec host when explicitly preferred", async () => {
    const { runCommand, runViaMacAppExecHost, sendInvokeResult } = await runSystemInvoke({
      preferMacAppExecHost: true,
      runViaResponse: createMacExecHostSuccess(),
    });

    expect(runViaMacAppExecHost).toHaveBeenCalledWith({
      approvals: expect.objectContaining({
        agent: expect.objectContaining({
          ask: "off",
          security: "full",
        }),
      }),
      request: expect.objectContaining({
        command: ["echo", "ok"],
      }),
    });
    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeOk(sendInvokeResult, { payloadContains: "app-ok" });
  });

  it("forwards canonical command text to mac app exec host for positional-argv shell wrappers", async () => {
    const { runViaMacAppExecHost } = await runSystemInvoke({
      command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
      preferMacAppExecHost: true,
      runViaResponse: createMacExecHostSuccess(),
    });

    expect(runViaMacAppExecHost).toHaveBeenCalledWith({
      approvals: expect.anything(),
      request: expect.objectContaining({
        command: ["/bin/sh", "-lc", '$0 "$1"', "/usr/bin/touch", "/tmp/marker"],
        rawCommand: '/bin/sh -lc "$0 \\"$1\\"" /usr/bin/touch /tmp/marker',
      }),
    });
  });

  const approvedEnvShellWrapperCases = [
    {
      name: "preserves wrapper argv for approved env shell commands in local execution",
      preferMacAppExecHost: false,
    },
    {
      name: "preserves wrapper argv for approved env shell commands in mac app exec host forwarding",
      preferMacAppExecHost: true,
    },
  ] as const;

  for (const testCase of approvedEnvShellWrapperCases) {
    it.runIf(process.platform !== "win32")(testCase.name, async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approved-wrapper-"));
      const marker = path.join(tmp, "marker");
      const attackerScript = path.join(tmp, "sh");
      fs.writeFileSync(attackerScript, "#!/bin/sh\necho exploited > marker\n");
      fs.chmodSync(attackerScript, 0o755);
      const runCommand = vi.fn(async (argv: string[]) => {
        if (argv[0] === "/bin/sh" && argv[1] === "sh" && argv[2] === "-c") {
          fs.writeFileSync(marker, "rewritten");
        }
        return createLocalRunResult();
      });
      const sendInvokeResult = vi.fn(async () => {});
      try {
        const invoke = await runSystemInvoke({
          approved: true,
          ask: "on-miss",
          command: ["env", "sh", "-c", "echo SAFE"],
          cwd: tmp,
          preferMacAppExecHost: testCase.preferMacAppExecHost,
          runCommand,
          runViaResponse: testCase.preferMacAppExecHost
            ? {
                ok: true,
                payload: {
                  error: null,
                  exitCode: 0,
                  stderr: "",
                  stdout: "app-ok",
                  success: true,
                  timedOut: false,
                },
              }
            : undefined,
          security: "allowlist",
          sendInvokeResult,
        });

        if (testCase.preferMacAppExecHost) {
          const canonicalCwd = fs.realpathSync(tmp);
          expect(invoke.runCommand).not.toHaveBeenCalled();
          expect(invoke.runViaMacAppExecHost).toHaveBeenCalledWith({
            approvals: expect.anything(),
            request: expect.objectContaining({
              command: ["env", "sh", "-c", "echo SAFE"],
              cwd: canonicalCwd,
              rawCommand: 'env sh -c "echo SAFE"',
            }),
          });
          expectInvokeOk(invoke.sendInvokeResult, { payloadContains: "app-ok" });
          return;
        }

        const runArgs = vi.mocked(invoke.runCommand).mock.calls[0]?.[0] as string[] | undefined;
        expect(runArgs).toEqual(["env", "sh", "-c", "echo SAFE"]);
        expect(fs.existsSync(marker)).toBe(false);
        expectInvokeOk(invoke.sendInvokeResult);
      } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
      }
    });
  }

  it("handles transparent env wrappers in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      command: ["env", "tr", "a", "b"],
      preferMacAppExecHost: false,
      security: "allowlist",
    });
    if (process.platform === "win32") {
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
      return;
    }

    const runArgs = vi.mocked(runCommand).mock.calls[0]?.[0] as string[] | undefined;
    expect(runArgs).toBeDefined();
    expect(runArgs?.[0]).toMatch(/(^|[/\\])tr$/);
    expect(runArgs?.slice(1)).toEqual(["a", "b"]);
    expectInvokeOk(sendInvokeResult);
  });

  it("denies semantic env wrappers in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      command: ["env", "FOO=bar", "tr", "a", "b"],
      preferMacAppExecHost: false,
      security: "allowlist",
    });
    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
  });

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path for approval-based runs",
    async () => {
      await withPathTokenCommand({
        run: async ({ expected }) => {
          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            approved: true,
            ask: "off",
            command: ["poccmd", "-n", "SAFE"],
            preferMacAppExecHost: false,
            security: "full",
          });
          expectCommandPinnedToCanonicalPath({
            commandTail: ["-n", "SAFE"],
            expected,
            runCommand,
          });
          expectInvokeOk(sendInvokeResult);
        },
        tmpPrefix: "openclaw-approval-path-pin-",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts prepared plans after PATH-token hardening rewrites argv",
    async () => {
      await withPathTokenCommand({
        run: async ({ expected }) => {
          const prepared = buildSystemRunApprovalPlan({
            command: ["poccmd", "hello"],
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error("unreachable");
          }

          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            approved: true,
            ask: "off",
            command: prepared.plan.argv,
            preferMacAppExecHost: false,
            rawCommand: prepared.plan.commandText,
            security: "full",
          });
          expectCommandPinnedToCanonicalPath({
            commandTail: ["hello"],
            expected,
            runCommand,
          });
          expectInvokeOk(sendInvokeResult);
        },
        tmpPrefix: "openclaw-prepare-run-path-pin-",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins PATH-token executable to canonical path for allowlist runs",
    async () => {
      const runCommand = vi.fn(async () => ({
        ...createLocalRunResult(),
      }));
      const sendInvokeResult = vi.fn(async () => {});
      await withPathTokenCommand({
        run: async ({ link, expected }) => {
          await withTempApprovalsHome({
            approvals: {
              agents: {
                main: {
                  allowlist: [{ pattern: link }],
                },
              },
              defaults: {
                ask: "off",
                askFallback: "deny",
                security: "allowlist",
              },
              version: 1,
            },
            run: async () => {
              await runSystemInvoke({
                ask: "off",
                command: ["poccmd", "-n", "SAFE"],
                preferMacAppExecHost: false,
                runCommand,
                security: "allowlist",
                sendInvokeResult,
              });
            },
          });
          expectCommandPinnedToCanonicalPath({
            commandTail: ["-n", "SAFE"],
            expected,
            runCommand,
          });
          expectInvokeOk(sendInvokeResult);
        },
        tmpPrefix: "openclaw-allowlist-path-pin-",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "denies approval-based execution when cwd is a symlink",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-link-"));
      const safeDir = path.join(tmp, "safe");
      const linkDir = path.join(tmp, "cwd-link");
      const script = path.join(safeDir, "run.sh");
      fs.mkdirSync(safeDir, { recursive: true });
      fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
      fs.chmodSync(script, 0o755);
      fs.symlinkSync(safeDir, linkDir, "dir");
      try {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          approved: true,
          ask: "off",
          command: ["./run.sh"],
          cwd: linkDir,
          preferMacAppExecHost: false,
          security: "full",
        });
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, { message: "canonical cwd" });
      } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "denies approval-based execution when cwd contains a symlink parent component",
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-parent-link-"));
      const safeRoot = path.join(tmp, "safe-root");
      const safeSub = path.join(safeRoot, "sub");
      const linkRoot = path.join(tmp, "approved-link");
      fs.mkdirSync(safeSub, { recursive: true });
      fs.symlinkSync(safeRoot, linkRoot, "dir");
      try {
        const { runCommand, sendInvokeResult } = await runSystemInvoke({
          approved: true,
          ask: "off",
          command: ["./run.sh"],
          cwd: path.join(linkRoot, "sub"),
          preferMacAppExecHost: false,
          security: "full",
        });
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, { message: "no symlink path components" });
      } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
      }
    },
  );

  it("uses canonical executable path for approval-based relative command execution", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-real-"));
    const script = path.join(tmp, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(script, 0o755);
    try {
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        approved: true,
        ask: "off",
        command: ["./run.sh", "--flag"],
        cwd: tmp,
        preferMacAppExecHost: false,
        security: "full",
      });
      if (process.platform === "win32") {
        expect(runCommand).not.toHaveBeenCalled();
        expectInvokeErrorMessage(sendInvokeResult, {
          exact: true,
          message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
        });
        return;
      }
      expectCommandPinnedToCanonicalPath({
        commandTail: ["--flag"],
        cwd: fs.realpathSync(tmp),
        expected: fs.realpathSync(script),
        runCommand,
      });
      expectInvokeOk(sendInvokeResult);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("denies approval-based execution when cwd identity drifts before execution", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-drift-"));
    const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-cwd-drift-alt-"));
    const script = path.join(tmp, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho SAFE\n");
    fs.chmodSync(script, 0o755);
    const canonicalCwd = fs.realpathSync(tmp);
    try {
      await withMockedCwdIdentityDrift({
        canonicalCwd,
        driftDir: fallback,
        run: async () => {
          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            approved: true,
            ask: "off",
            command: ["./run.sh"],
            cwd: tmp,
            preferMacAppExecHost: false,
            security: "full",
          });
          expect(runCommand).not.toHaveBeenCalled();
          if (process.platform === "win32") {
            expectInvokeErrorMessage(sendInvokeResult, {
              exact: true,
              message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
            });
            return;
          }
          expectInvokeErrorMessage(sendInvokeResult, {
            exact: true,
            message: "SYSTEM_RUN_DENIED: approval cwd changed before execution",
          });
        },
      });
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
      fs.rmSync(fallback, { force: true, recursive: true });
    }
  });

  it("denies approval-based execution when a script operand changes after approval", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-script-drift-"));
    const fixture = createMutableScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: fixture.command,
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }

      fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        approved: true,
        ask: "off",
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        preferMacAppExecHost: false,
        rawCommand: prepared.plan.commandText,
        security: "full",
        systemRunPlan: prepared.plan,
      });

      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, {
        exact: true,
        message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
      });
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("keeps approved shell script execution working when the script is unchanged", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-script-stable-"));
    const fixture = createMutableScriptOperandFixture(tmp);
    fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.scriptPath, 0o755);
    }
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: fixture.command,
        cwd: tmp,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }

      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        approved: true,
        ask: "off",
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        preferMacAppExecHost: false,
        rawCommand: prepared.plan.commandText,
        security: "full",
        systemRunPlan: prepared.plan,
      });

      expect(runCommand).toHaveBeenCalledTimes(1);
      expectInvokeOk(sendInvokeResult);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  for (const runtime of ["bun", "deno", "tsx", "jiti"] as const) {
    it(`denies approval-based execution when a ${runtime} script operand changes after approval`, async () => {
      await withFakeRuntimeOnPath({
        run: async () => {
          const tmp = fs.mkdtempSync(
            path.join(os.tmpdir(), `openclaw-approval-${runtime}-script-drift-`),
          );
          const fixture = createRuntimeScriptOperandFixture({ runtime, tmp });
          fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
          try {
            const prepared = buildSystemRunApprovalPlan({
              command: fixture.command,
              cwd: tmp,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }

            fs.writeFileSync(fixture.scriptPath, fixture.changedBody);
            const { runCommand, sendInvokeResult } = await runSystemInvoke({
              approved: true,
              ask: "off",
              command: prepared.plan.argv,
              cwd: prepared.plan.cwd ?? tmp,
              preferMacAppExecHost: false,
              rawCommand: prepared.plan.commandText,
              security: "full",
              systemRunPlan: prepared.plan,
            });

            expect(runCommand).not.toHaveBeenCalled();
            expectInvokeErrorMessage(sendInvokeResult, {
              exact: true,
              message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
            });
          } finally {
            fs.rmSync(tmp, { force: true, recursive: true });
          }
        },
        runtime,
      });
    });

    it(`keeps approved ${runtime} script execution working when the script is unchanged`, async () => {
      await withFakeRuntimeOnPath({
        run: async () => {
          const tmp = fs.mkdtempSync(
            path.join(os.tmpdir(), `openclaw-approval-${runtime}-script-stable-`),
          );
          const fixture = createRuntimeScriptOperandFixture({ runtime, tmp });
          fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
          try {
            const prepared = buildSystemRunApprovalPlan({
              command: fixture.command,
              cwd: tmp,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }

            const { runCommand, sendInvokeResult } = await runSystemInvoke({
              approved: true,
              ask: "off",
              command: prepared.plan.argv,
              cwd: prepared.plan.cwd ?? tmp,
              preferMacAppExecHost: false,
              rawCommand: prepared.plan.commandText,
              security: "full",
              systemRunPlan: prepared.plan,
            });

            expect(runCommand).toHaveBeenCalledTimes(1);
            expectInvokeOk(sendInvokeResult);
          } finally {
            fs.rmSync(tmp, { force: true, recursive: true });
          }
        },
        runtime,
      });
    });
  }

  it("denies approval-based execution when tsx is missing a required mutable script binding", async () => {
    await withFakeRuntimeOnPath({
      run: async () => {
        const tmp = fs.mkdtempSync(
          path.join(os.tmpdir(), "openclaw-approval-tsx-missing-binding-"),
        );
        const fixture = createRuntimeScriptOperandFixture({ runtime: "tsx", tmp });
        fs.writeFileSync(fixture.scriptPath, fixture.initialBody);
        try {
          const prepared = buildSystemRunApprovalPlan({
            command: fixture.command,
            cwd: tmp,
          });
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error("unreachable");
          }

          const planWithoutBinding = { ...prepared.plan };
          delete planWithoutBinding.mutableFileOperand;
          const { runCommand, sendInvokeResult } = await runSystemInvoke({
            approved: true,
            ask: "off",
            command: prepared.plan.argv,
            cwd: prepared.plan.cwd ?? tmp,
            preferMacAppExecHost: false,
            rawCommand: prepared.plan.commandText,
            security: "full",
            systemRunPlan: planWithoutBinding,
          });

          expect(runCommand).not.toHaveBeenCalled();
          expectInvokeErrorMessage(sendInvokeResult, {
            exact: true,
            message: "SYSTEM_RUN_DENIED: approval missing script operand binding",
          });
        } finally {
          fs.rmSync(tmp, { force: true, recursive: true });
        }
      },
      runtime: "tsx",
    });
  });

  it("denies ./sh wrapper spoof in allowlist on-miss mode before execution", async () => {
    const marker = path.join(os.tmpdir(), `openclaw-wrapper-spoof-${process.pid}-${Date.now()}`);
    const runCommand = vi.fn(async () => {
      fs.writeFileSync(marker, "executed");
      return createLocalRunResult();
    });
    const sendInvokeResult = vi.fn(async () => {});
    const sendNodeEvent = vi.fn(async () => {});

    await runSystemInvoke({
      ask: "on-miss",
      command: ["./sh", "-lc", "/bin/echo approved-only"],
      preferMacAppExecHost: false,
      runCommand,
      security: "allowlist",
      sendInvokeResult,
      sendNodeEvent,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
    expectApprovalRequiredDenied({ sendInvokeResult, sendNodeEvent });
    try {
      fs.unlinkSync(marker);
    } catch {
      // No-op
    }
  });

  it("denies ./skill-bin even when autoAllowSkills trust entry exists", async () => {
    const { runCommand, sendInvokeResult, sendNodeEvent } = createInvokeSpies();

    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals({ autoAllowSkills: true }),
      run: async ({ tempHome }) => {
        const skillBinPath = path.join(tempHome, "skill-bin");
        fs.writeFileSync(skillBinPath, "#!/bin/sh\necho should-not-run\n", { mode: 0o755 });
        fs.chmodSync(skillBinPath, 0o755);
        await runSystemInvoke({
          ask: "on-miss",
          command: ["./skill-bin", "--help"],
          cwd: tempHome,
          preferMacAppExecHost: false,
          runCommand,
          security: "allowlist",
          sendInvokeResult,
          sendNodeEvent,
          skillBinsCurrent: async () => [{ name: "skill-bin", resolvedPath: skillBinPath }],
        });
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendInvokeResult, sendNodeEvent });
  });

  it("denies env -S shell payloads in allowlist mode", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      command: ["env", "-S", 'sh -c "echo pwned"'],
      preferMacAppExecHost: false,
      security: "allowlist",
    });
    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, { message: "allowlist miss" });
  });

  it("denies semicolon-chained shell payloads in allowlist mode without explicit approval", async () => {
    const payloads = ["openclaw status; id", "openclaw status; cat /etc/passwd"];
    for (const payload of payloads) {
      const command =
        process.platform === "win32"
          ? ["cmd.exe", "/d", "/s", "/c", payload]
          : ["/bin/sh", "-lc", payload];
      const { runCommand, sendInvokeResult } = await runSystemInvoke({
        ask: "on-miss",
        command,
        preferMacAppExecHost: false,
        security: "allowlist",
      });
      expect(runCommand, payload).not.toHaveBeenCalled();
      expectInvokeErrorMessage(sendInvokeResult, {
        exact: true,
        message: "SYSTEM_RUN_DENIED: approval required",
      });
    }
  });

  it("denies PowerShell encoded-command payloads in allowlist mode without explicit approval", async () => {
    const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
      ask: "on-miss",
      command: ["pwsh", "-EncodedCommand", "ZQBjAGgAbwAgAHAAdwBuAGUAZAA="],
      preferMacAppExecHost: false,
      security: "allowlist",
    });
    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendInvokeResult, sendNodeEvent });
  });

  it("rejects blocked environment overrides before execution", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      ask: "off",
      env: { CLASSPATH: "/tmp/evil-classpath" },
      preferMacAppExecHost: false,
      security: "full",
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, {
      message: "SYSTEM_RUN_DENIED: environment override rejected",
    });
    expectInvokeErrorMessage(sendInvokeResult, {
      message: "CLASSPATH",
    });
  });

  it("rejects blocked environment overrides for shell-wrapper commands", async () => {
    const shellCommand =
      process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "echo ok"]
        : ["/bin/sh", "-lc", "echo ok"];
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      ask: "off",
      command: shellCommand,
      env: {
        CLASSPATH: "/tmp/evil-classpath",
        LANG: "C",
      },
      preferMacAppExecHost: false,
      security: "full",
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, {
      message: "SYSTEM_RUN_DENIED: environment override rejected",
    });
    expectInvokeErrorMessage(sendInvokeResult, {
      message: "CLASSPATH",
    });
  });

  it("rejects invalid non-portable environment override keys before execution", async () => {
    const { runCommand, sendInvokeResult } = await runSystemInvoke({
      ask: "off",
      env: { "BAD-KEY": "x" },
      preferMacAppExecHost: false,
      security: "full",
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectInvokeErrorMessage(sendInvokeResult, {
      message: "SYSTEM_RUN_DENIED: environment override rejected",
    });
    expectInvokeErrorMessage(sendInvokeResult, {
      message: "BAD-KEY",
    });
  });

  async function expectNestedEnvShellDenied(params: {
    depth: number;
    markerName: string;
    errorLabel: string;
  }) {
    const { runCommand, sendInvokeResult, sendNodeEvent } = createInvokeSpies({
      runCommand: vi.fn(async () => {
        throw new Error(params.errorLabel);
      }),
    });

    await withTempApprovalsHome({
      approvals: createAllowlistOnMissApprovals({
        agents: {
          main: {
            allowlist: [{ pattern: "/usr/bin/env" }],
          },
        },
      }),
      run: async ({ tempHome }) => {
        const marker = path.join(tempHome, params.markerName);
        await runSystemInvoke({
          ask: "on-miss",
          command: buildNestedEnvShellCommand({
            depth: params.depth,
            payload: `echo PWNED > ${marker}`,
          }),
          preferMacAppExecHost: false,
          runCommand,
          security: "allowlist",
          sendInvokeResult,
          sendNodeEvent,
        });
        expect(fs.existsSync(marker)).toBe(false);
      },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied({ sendInvokeResult, sendNodeEvent });
  }

  it("denies env-wrapped shell payloads at the dispatch depth boundary", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expectNestedEnvShellDenied({
      depth: 4,
      errorLabel: "runCommand should not be called for depth-boundary shell wrappers",
      markerName: "depth4-pwned.txt",
    });
  });

  it("denies nested env shell payloads when wrapper depth is exceeded", async () => {
    if (process.platform === "win32") {
      return;
    }
    await expectNestedEnvShellDenied({
      depth: 5,
      errorLabel: "runCommand should not be called for nested env depth overflow",
      markerName: "pwned.txt",
    });
  });

  it.each([
    {
      command: ["python3", "-c", "print('hi')"],
      expected: "python3 -c requires explicit approval in strictInlineEval mode",
    },
    {
      command: ["awk", 'BEGIN{system("id")}', "/dev/null"],
      expected: "awk inline program requires explicit approval in strictInlineEval mode",
    },
    {
      command: ["find", ".", "-exec", "id", "{}", ";"],
      expected: "find -exec requires explicit approval in strictInlineEval mode",
    },
    {
      command: ["xargs", "id"],
      expected: "xargs inline command requires explicit approval in strictInlineEval mode",
    },
    {
      command: ["make", "-f", "evil.mk"],
      expected: "make -f requires explicit approval in strictInlineEval mode",
    },
    {
      command: ["sed", "s/.*/id/e", "/dev/null"],
      expected: "sed inline program requires explicit approval in strictInlineEval mode",
    },
  ] as const)("requires explicit approval for strict inline-eval carrier %j", async (testCase) => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
        ask: "off",
        command: [...testCase.command],
        preferMacAppExecHost: false,
        security: "full",
      });

      expect(runCommand).not.toHaveBeenCalled();
      expect(sendNodeEvent).toHaveBeenCalledWith(
        expect.anything(),
        "exec.denied",
        expect.objectContaining({ reason: "approval-required" }),
      );
      expectInvokeErrorMessage(sendInvokeResult, {
        message: testCase.expected,
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("prefers strict inline-eval denial over generic allowlist prompts", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      const { runCommand, sendInvokeResult, sendNodeEvent } = await runSystemInvoke({
        ask: "on-miss",
        command: ["awk", 'BEGIN{system("id")}', "/dev/null"],
        preferMacAppExecHost: false,
        security: "allowlist",
      });

      expect(runCommand).not.toHaveBeenCalled();
      expect(sendNodeEvent).toHaveBeenCalledWith(
        expect.anything(),
        "exec.denied",
        expect.objectContaining({ reason: "approval-required" }),
      );
      expectInvokeErrorMessage(sendInvokeResult, {
        message: "awk inline program requires explicit approval in strictInlineEval mode",
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each([
    { args: ["-c", "print('hi')"], executable: "python3" },
    { args: ['BEGIN{system("id")}', "/dev/null"], executable: "awk" },
    { args: [".", "-exec", "id", "{}", ";"], executable: "find" },
    { args: ["id"], executable: "xargs" },
    { args: ["s/.*/id/e", "/dev/null"], executable: "sed" },
  ] as const)(
    "does not persist allow-always approvals for strict inline-eval carrier %j",
    async (testCase) => {
      setRuntimeConfigSnapshot({
        tools: {
          exec: {
            strictInlineEval: true,
          },
        },
      });
      try {
        await withTempApprovalsHome({
          approvals: createAllowlistOnMissApprovals(),
          run: async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inline-eval-bin-"));
            try {
              const executablePath = createTempExecutable({
                dir: tempDir,
                name: testCase.executable,
              });
              const { runCommand, sendInvokeResult } = await runSystemInvoke({
                approvalDecision: "allow-always",
                approved: true,
                ask: "on-miss",
                command: [executablePath, ...testCase.args],
                preferMacAppExecHost: false,
                runCommand: vi.fn(async () => createLocalRunResult("inline-eval-ok")),
                security: "allowlist",
              });

              expect(runCommand).toHaveBeenCalledTimes(1);
              expectInvokeOk(sendInvokeResult, { payloadContains: "inline-eval-ok" });
              expect(loadExecApprovals().agents?.main?.allowlist ?? []).toEqual([]);
            } finally {
              fs.rmSync(tempDir, { force: true, recursive: true });
            }
          },
        });
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("persists benign awk allow-always approvals in strict inline-eval mode without reopening inline carriers", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals(),
        run: async () => {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inline-eval-awk-"));
          try {
            const executablePath = createTempExecutable({
              dir: tempDir,
              name: "awk",
            });
            const benign = await runSystemInvoke({
              approvalDecision: "allow-always",
              approved: true,
              ask: "on-miss",
              command: [executablePath, "-F", ",", "-f", "script.awk", "data.csv"],
              cwd: tempDir,
              preferMacAppExecHost: false,
              runCommand: vi.fn(async () => createLocalRunResult("awk-ok")),
              security: "allowlist",
            });

            expect(benign.runCommand).toHaveBeenCalledTimes(1);
            expectInvokeOk(benign.sendInvokeResult, { payloadContains: "awk-ok" });
            expect(loadExecApprovals().agents?.main?.allowlist ?? []).toEqual([
              expect.objectContaining({ pattern: executablePath }),
            ]);

            const malicious = await runSystemInvoke({
              ask: "on-miss",
              command: [executablePath, 'BEGIN{system("id")}', "/dev/null"],
              cwd: tempDir,
              preferMacAppExecHost: false,
              security: "allowlist",
            });

            expect(malicious.runCommand).not.toHaveBeenCalled();
            expectInvokeErrorMessage(malicious.sendInvokeResult, {
              message: "awk inline program requires explicit approval in strictInlineEval mode",
            });
          } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
          }
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not persist allow-always approvals for strict inline-eval make carriers", async () => {
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          strictInlineEval: true,
        },
      },
    });
    try {
      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals(),
        run: async () => {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inline-eval-make-"));
          try {
            const executablePath = createTempExecutable({
              dir: tempDir,
              name: "make",
            });
            const makefilePath = path.join(tempDir, "Makefile");
            fs.writeFileSync(makefilePath, "all:\n\t@echo inline-eval-ok\n");
            const prepared = buildSystemRunApprovalPlan({
              command: [executablePath, "-f", makefilePath],
              cwd: tempDir,
            });
            expect(prepared.ok).toBe(true);
            if (!prepared.ok) {
              throw new Error("unreachable");
            }

            const { runCommand, sendInvokeResult } = await runSystemInvoke({
              approvalDecision: "allow-always",
              approved: true,
              ask: "on-miss",
              command: prepared.plan.argv,
              cwd: prepared.plan.cwd ?? tempDir,
              preferMacAppExecHost: false,
              rawCommand: prepared.plan.commandText,
              runCommand: vi.fn(async () => createLocalRunResult("inline-eval-ok")),
              security: "allowlist",
              systemRunPlan: prepared.plan,
            });

            expect(runCommand).toHaveBeenCalledTimes(1);
            expectInvokeOk(sendInvokeResult, { payloadContains: "inline-eval-ok" });
            expect(loadExecApprovals().agents?.main?.allowlist ?? []).toEqual([]);
          } finally {
            fs.rmSync(tempDir, { force: true, recursive: true });
          }
        },
      });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.runIf(process.platform !== "win32")(
    "auto-runs allowlisted inner scripts through transport shell wrappers",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-wrapper-inner-"));
      try {
        const scriptsDir = path.join(tempDir, "scripts");
        fs.mkdirSync(scriptsDir, { recursive: true });
        const scriptPath = path.join(scriptsDir, "check_mail.sh");
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
        fs.chmodSync(scriptPath, 0o755);

        await withTempApprovalsHome({
          approvals: createAllowlistOnMissApprovals({
            agents: {
              main: {
                allowlist: [{ pattern: scriptPath }],
              },
            },
          }),
          run: async () => {
            const invoke = await runSystemInvoke({
              ask: "on-miss",
              command: ["/bin/sh", "-lc", "./scripts/check_mail.sh --limit 5"],
              cwd: tempDir,
              preferMacAppExecHost: false,
              rawCommand: '/bin/sh -lc "./scripts/check_mail.sh --limit 5"',
              runCommand: vi.fn(async () => createLocalRunResult("shell-wrapper-inner-ok")),
              security: "allowlist",
            });

            expect(invoke.runCommand).toHaveBeenCalledTimes(1);
            expectInvokeOk(invoke.sendInvokeResult, {
              payloadContains: "shell-wrapper-inner-ok",
            });
          },
        });
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps cmd.exe transport wrappers approval-gated on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cmd-wrapper-allow-"));
    try {
      const scriptPath = path.join(tempDir, "check_mail.cmd");
      fs.writeFileSync(scriptPath, "@echo off\r\necho ok\r\n");

      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals({
          agents: {
            main: {
              allowlist: [{ pattern: scriptPath }],
            },
          },
        }),
        run: async () => {
          const invoke = await runSystemInvoke({
            ask: "on-miss",
            command: ["cmd.exe", "/d", "/s", "/c", `${scriptPath} --limit 5`],
            cwd: tempDir,
            isCmdExeInvocation: (argv) => {
              const token = argv[0]?.trim();
              if (!token) {
                return false;
              }
              const base = path.win32.basename(token).toLowerCase();
              return base === "cmd.exe" || base === "cmd";
            },
            preferMacAppExecHost: false,
            security: "allowlist",
          });

          expect(invoke.runCommand).not.toHaveBeenCalled();
          expectApprovalRequiredDenied({
            sendInvokeResult: invoke.sendInvokeResult,
            sendNodeEvent: invoke.sendNodeEvent,
          });
        },
      });
    } finally {
      platformSpy.mockRestore();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      command: ["env", "cmd.exe", "/d", "/s", "/c"],
      name: "keeps env cmd.exe transport wrappers approval-gated on Windows",
    },
    {
      command: ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c"],
      name: "keeps env-assignment cmd.exe transport wrappers approval-gated on Windows",
    },
  ])("$name", async ({ command }) => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-env-cmd-wrapper-allow-"));
    try {
      const scriptPath = path.join(tempDir, "check_mail.cmd");
      fs.writeFileSync(scriptPath, "@echo off\r\necho ok\r\n");
      const wrappedCommand = [...command, `${scriptPath} --limit 5`];

      await withTempApprovalsHome({
        approvals: createAllowlistOnMissApprovals({
          agents: {
            main: {
              allowlist: [{ pattern: scriptPath }],
            },
          },
        }),
        run: async () => {
          const seenArgv: string[][] = [];
          const invoke = await runSystemInvoke({
            ask: "on-miss",
            command: wrappedCommand,
            cwd: tempDir,
            isCmdExeInvocation: (argv) => {
              seenArgv.push([...argv]);
              const token = argv[0]?.trim();
              if (!token) {
                return false;
              }
              const base = path.win32.basename(token).toLowerCase();
              return base === "cmd.exe" || base === "cmd";
            },
            preferMacAppExecHost: false,
            security: "allowlist",
          });

          expect(seenArgv).toContainEqual(["cmd.exe", "/d", "/s", "/c", `${scriptPath} --limit 5`]);
          expect(invoke.runCommand).not.toHaveBeenCalled();
          expectApprovalRequiredDenied({
            sendInvokeResult: invoke.sendInvokeResult,
            sendNodeEvent: invoke.sendNodeEvent,
          });
        },
      });
    } finally {
      platformSpy.mockRestore();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("reuses exact-command durable trust for shell-wrapper reruns", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shell-wrapper-allow-"));
    try {
      const prepared = buildSystemRunApprovalPlan({
        command: ["/bin/sh", "-lc", "cd ."],
        cwd: tempDir,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error("unreachable");
      }

      await withTempApprovalsHome({
        approvals: {
          agents: {
            main: {
              allowlist: [
                {
                  pattern: `=command:${crypto
                    .createHash("sha256")
                    .update(prepared.plan.commandText)
                    .digest("hex")
                    .slice(0, 16)}`,
                  source: "allow-always",
                },
              ],
            },
          },
          defaults: { ask: "on-miss", askFallback: "full", security: "allowlist" },
          version: 1,
        },
        run: async () => {
          const rerun = await runSystemInvoke({
            ask: "on-miss",
            command: prepared.plan.argv,
            cwd: prepared.plan.cwd ?? tempDir,
            preferMacAppExecHost: false,
            rawCommand: prepared.plan.commandText,
            runCommand: vi.fn(async () => createLocalRunResult("shell-wrapper-reused")),
            security: "allowlist",
            systemRunPlan: prepared.plan,
          });

          expect(rerun.runCommand).toHaveBeenCalledTimes(1);
          expectInvokeOk(rerun.sendInvokeResult, { payloadContains: "shell-wrapper-reused" });
        },
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
