import { describe, expect, test } from "vitest";
import {
  basenameLower,
  extractShellWrapperCommand,
  extractShellWrapperInlineCommand,
  hasEnvManipulationBeforeShellWrapper,
  isDispatchWrapperExecutable,
  isShellWrapperExecutable,
  normalizeExecutableToken,
  resolveDispatchWrapperTrustPlan,
  resolveShellWrapperTransportArgv,
  unwrapEnvInvocation,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";

function supportsScriptPositionalCommandForTests(): boolean {
  return process.platform === "darwin" || process.platform === "freebsd";
}

function expectTransparentDispatchWrapperCase(params: {
  argv: string[];
  wrapper: string;
  effectiveArgv: string[];
}) {
  expect(isDispatchWrapperExecutable(params.wrapper)).toBe(true);
  expect(unwrapKnownDispatchWrapperInvocation(params.argv)).toEqual({
    argv: params.effectiveArgv,
    kind: "unwrapped",
    wrapper: params.wrapper,
  });
  expect(resolveDispatchWrapperTrustPlan(params.argv)).toEqual({
    argv: params.effectiveArgv,
    policyBlocked: false,
    wrappers: [params.wrapper],
  });
}

describe("basenameLower", () => {
  test.each([
    { expected: "bun.cmd", token: " Bun.CMD " },
    { expected: "pwsh.exe", token: "C:\\tools\\PwSh.EXE" },
    { expected: "bash", token: "/tmp/bash" },
  ])("normalizes basenames for %j", ({ token, expected }) => {
    expect(basenameLower(token)).toBe(expected);
  });
});

describe("normalizeExecutableToken", () => {
  test.each([
    { expected: "bun", token: "bun.cmd" },
    { expected: "deno", token: "deno.bat" },
    { expected: "pwsh", token: "pwsh.com" },
    { expected: "cmd", token: "cmd.exe" },
    { expected: "bun", token: "C:\\tools\\bun.cmd" },
    { expected: "deno", token: "/tmp/deno.exe" },
    { expected: "bash", token: " /tmp/bash " },
  ])("normalizes executable tokens for %j", ({ token, expected }) => {
    expect(normalizeExecutableToken(token)).toBe(expected);
  });
});

describe("wrapper classification", () => {
  test.each([
    { dispatch: true, shell: false, token: "sudo" },
    { dispatch: true, shell: false, token: "caffeinate" },
    { dispatch: true, shell: false, token: "sandbox-exec" },
    { dispatch: true, shell: false, token: "script" },
    { dispatch: true, shell: false, token: "time" },
    { dispatch: true, shell: false, token: "timeout.exe" },
    { dispatch: false, shell: true, token: "bash" },
    { dispatch: false, shell: true, token: "pwsh.exe" },
    { dispatch: false, shell: false, token: "node" },
  ])("classifies wrappers for %j", ({ token, dispatch, shell }) => {
    expect(isDispatchWrapperExecutable(token)).toBe(dispatch);
    expect(isShellWrapperExecutable(token)).toBe(shell);
  });
});

describe("unwrapKnownShellMultiplexerInvocation", () => {
  test.each([
    { argv: [], expected: { kind: "not-wrapper" } },
    { argv: ["node", "-e", "1"], expected: { kind: "not-wrapper" } },
    { argv: ["busybox"], expected: { kind: "blocked", wrapper: "busybox" } },
    { argv: ["busybox", "ls"], expected: { kind: "blocked", wrapper: "busybox" } },
    {
      argv: ["busybox", "sh", "-lc", "echo hi"],
      expected: { argv: ["sh", "-lc", "echo hi"], kind: "unwrapped", wrapper: "busybox" },
    },
    {
      argv: ["toybox", "--", "pwsh.exe", "-Command", "Get-Date"],
      expected: {
        argv: ["pwsh.exe", "-Command", "Get-Date"],
        kind: "unwrapped",
        wrapper: "toybox",
      },
    },
  ])("unwraps shell multiplexers for %j", ({ argv, expected }) => {
    expect(unwrapKnownShellMultiplexerInvocation(argv)).toEqual(expected);
  });
});

describe("unwrapEnvInvocation", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["env", "-i", "--unset", "PATH", "--", "sh", "-lc", "echo hi"],
      expected: ["sh", "-lc", "echo hi"],
    },
    {
      argv: ["env", "--chdir=/tmp", "pwsh", "-Command", "Get-Date"],
      expected: ["pwsh", "-Command", "Get-Date"],
    },
    {
      argv: ["env", "-", "bash", "-lc", "echo hi"],
      expected: ["bash", "-lc", "echo hi"],
    },
    {
      argv: ["env", "--bogus", "bash", "-lc", "echo hi"],
      expected: null,
    },
    {
      argv: ["env", "--unset"],
      expected: null,
    },
  ])("unwraps env invocations for %j", ({ argv, expected }) => {
    expect(unwrapEnvInvocation(argv)).toEqual(expected);
  });
});

describe("unwrapKnownDispatchWrapperInvocation", () => {
  test.each([
    {
      argv: ["caffeinate", "-d", "-w", "42", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "caffeinate" },
    },
    {
      argv: ["env", "--", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "env" },
    },
    {
      argv: ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "nice" },
    },
    {
      argv: ["nohup", "--", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "nohup" },
    },
    {
      argv: ["script", "-q", "/dev/null", "bash", "-lc", "echo hi"],
      expected: supportsScriptPositionalCommandForTests()
        ? { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "script" }
        : { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["script", "-E", "always", "/dev/null", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "stdbuf" },
    },
    {
      argv: ["time", "-p", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "time" },
    },
    {
      argv: ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      expected: { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "timeout" },
    },
    {
      argv: ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        kind: "unwrapped",
        wrapper: "sandbox-exec",
      },
    },
    {
      argv: ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        kind: "unwrapped",
        wrapper: "sandbox-exec",
      },
    },
    {
      argv: ["xcrun", "bash", "-lc", "echo hi"],
      expected:
        process.platform === "darwin"
          ? { argv: ["bash", "-lc", "echo hi"], kind: "unwrapped", wrapper: "xcrun" }
          : { kind: "blocked", wrapper: "xcrun" },
    },
    {
      argv: ["script", "-q", "/dev/null"],
      expected: { kind: "blocked", wrapper: "script" },
    },
    {
      argv: ["sudo", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "sudo" },
    },
    {
      argv: ["timeout", "--bogus", "5s", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "timeout" },
    },
    {
      argv: ["arch", "-e", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["arch", "-arch", "bogus", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["arch", "-arch", "bogus", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "arch" },
    },
    {
      argv: ["xcrun", "--sdk", "macosx", "bash", "-lc", "echo hi"],
      expected: { kind: "blocked", wrapper: "xcrun" },
    },
  ])("unwraps known dispatch wrappers for %j", ({ argv, expected }) => {
    expect(unwrapKnownDispatchWrapperInvocation(argv)).toEqual(expected);
  });

  test("blocks arch dispatch unwrapping outside macOS", () => {
    expect(
      unwrapKnownDispatchWrapperInvocation(["arch", "-arm64", "bash", "-lc", "echo hi"], "linux"),
    ).toEqual({
      kind: "blocked",
      wrapper: "arch",
    });
  });

  test.each(["chrt", "doas", "ionice", "setsid", "sudo", "taskset"])(
    "fails closed for blocked dispatch wrapper %s",
    (wrapper) => {
      expect(unwrapKnownDispatchWrapperInvocation([wrapper, "bash", "-lc", "echo hi"])).toEqual({
        kind: "blocked",
        wrapper,
      });
    },
  );
});

describe("resolveDispatchWrapperTrustPlan", () => {
  test("allows non-semantic env passthrough", () => {
    expect(resolveDispatchWrapperTrustPlan(["env", "--", "bash", "-lc", "echo hi"])).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      policyBlocked: false,
      wrappers: ["env"],
    });
  });

  test.each([
    {
      argv: ["caffeinate", "-d", "-t", "60", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "caffeinate",
    },
    {
      argv: ["nice", "-n", "5", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "nice",
    },
    {
      argv: ["nohup", "--", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "nohup",
    },
    {
      argv: ["sandbox-exec", "-p", "(allow default)", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "sandbox-exec",
    },
    {
      argv: ["sandbox-exec", "-D", "PROFILE", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "sandbox-exec",
    },
    {
      argv: ["stdbuf", "-o", "L", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "stdbuf",
    },
    {
      argv: ["time", "-p", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "time",
    },
    {
      argv: ["timeout", "--signal=TERM", "5s", "bash", "-lc", "echo hi"],
      effectiveArgv: ["bash", "-lc", "echo hi"],
      wrapper: "timeout",
    },
    ...(process.platform === "darwin"
      ? [
          {
            argv: ["arch", "-arm64", "bash", "-lc", "echo hi"],
            effectiveArgv: ["bash", "-lc", "echo hi"],
            wrapper: "arch",
          },
          {
            argv: ["xcrun", "bash", "-lc", "echo hi"],
            effectiveArgv: ["bash", "-lc", "echo hi"],
            wrapper: "xcrun",
          },
        ]
      : []),
  ])("keeps transparent wrapper handling in sync for %s", ({ argv, wrapper, effectiveArgv }) => {
    expectTransparentDispatchWrapperCase({ argv, effectiveArgv, wrapper });
  });

  test("unwraps transparent wrapper chains", () => {
    expect(
      resolveDispatchWrapperTrustPlan(["nohup", "nice", "-n", "5", "bash", "-lc", "echo hi"]),
    ).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      policyBlocked: false,
      wrappers: ["nohup", "nice"],
    });
  });

  test("blocks arch trust unwrapping outside macOS", () => {
    expect(
      resolveDispatchWrapperTrustPlan(
        ["arch", "-arm64", "bash", "-lc", "echo hi"],
        undefined,
        "linux",
      ),
    ).toEqual({
      argv: ["arch", "-arm64", "bash", "-lc", "echo hi"],
      blockedWrapper: "arch",
      policyBlocked: true,
      wrappers: [],
    });
  });

  test("blocks semantic env usage even when it reaches a shell wrapper", () => {
    expect(resolveDispatchWrapperTrustPlan(["env", "FOO=bar", "bash", "-lc", "echo hi"])).toEqual({
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      blockedWrapper: "env",
      policyBlocked: true,
      wrappers: ["env"],
    });
  });

  test("blocks wrapper overflow beyond the configured depth", () => {
    expect(
      resolveDispatchWrapperTrustPlan(["nohup", "timeout", "5s", "bash", "-lc", "echo hi"], 1),
    ).toEqual({
      argv: ["timeout", "5s", "bash", "-lc", "echo hi"],
      blockedWrapper: "timeout",
      policyBlocked: true,
      wrappers: ["nohup"],
    });
  });
});

describe("hasEnvManipulationBeforeShellWrapper", () => {
  test.each([
    {
      argv: ["env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["timeout", "5s", "env", "--", "bash", "-lc", "echo hi"],
      expected: false,
    },
    {
      argv: ["timeout", "5s", "env", "FOO=bar", "bash", "-lc", "echo hi"],
      expected: true,
    },
    {
      argv: ["sudo", "bash", "-lc", "echo hi"],
      expected: false,
    },
  ])("detects env manipulation before shell wrappers for %j", ({ argv, expected }) => {
    expect(hasEnvManipulationBeforeShellWrapper(argv)).toBe(expected);
  });
});

describe("resolveShellWrapperTransportArgv", () => {
  test.each([
    {
      argv: ["env", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      expected: ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    },
    {
      argv: ["env", "FOO=bar", "cmd.exe", "/d", "/s", "/c", "echo hi"],
      expected: ["cmd.exe", "/d", "/s", "/c", "echo hi"],
    },
    {
      argv: ["bash", "script.sh"],
      expected: null,
    },
  ])("resolves wrapper transport argv for %j", ({ argv, expected }) => {
    expect(resolveShellWrapperTransportArgv(argv)).toEqual(expected);
  });
});

describe("extractShellWrapperCommand", () => {
  test.each([
    {
      argv: ["bash", "-lc", "echo hi"],
      expectedCommand: { command: "echo hi", isWrapper: true },
      expectedInline: "echo hi",
    },
    {
      argv: ["busybox", "sh", "-lc", "echo hi"],
      expectedCommand: { command: "echo hi", isWrapper: true },
      expectedInline: "echo hi",
    },
    {
      argv: ["env", "--", "pwsh", "-Command", "Get-Date"],
      expectedCommand: { command: "Get-Date", isWrapper: true },
      expectedInline: "Get-Date",
    },
    {
      argv: ["bash", "script.sh"],
      expectedCommand: { command: null, isWrapper: false },
      expectedInline: null,
    },
  ])("extracts inline commands for %j", ({ argv, expectedInline, expectedCommand }) => {
    expect(extractShellWrapperInlineCommand(argv)).toBe(expectedInline);
    expect(extractShellWrapperCommand(argv)).toEqual(expectedCommand);
  });

  test("prefers an explicit raw command override when provided", () => {
    expect(extractShellWrapperCommand(["bash", "-lc", "echo hi"], "  run this instead  ")).toEqual({
      command: "run this instead",
      isWrapper: true,
    });
  });
});
