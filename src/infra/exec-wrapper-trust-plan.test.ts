import { describe, expect, test } from "vitest";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";

describe("resolveExecWrapperTrustPlan", () => {
  test.each([
    {
      argv: ["/usr/bin/caffeinate", "-d", "-w", "42", "sh", "-lc", "echo hi"],
      enabled: process.platform !== "win32",
      expected: {
        argv: ["sh", "-lc", "echo hi"],
        policyArgv: ["sh", "-lc", "echo hi"],
        policyBlocked: false,
        shellInlineCommand: "echo hi",
        shellWrapperExecutable: true,
        wrapperChain: ["caffeinate"],
      },
      name: "unwraps transparent caffeinate wrappers before shell policy checks",
    },
    {
      argv: ["/usr/bin/time", "-p", "busybox", "sh", "-lc", "echo hi"],
      enabled: process.platform !== "win32",
      expected: {
        argv: ["sh", "-lc", "echo hi"],
        policyArgv: ["busybox", "sh", "-lc", "echo hi"],
        policyBlocked: false,
        shellInlineCommand: "echo hi",
        shellWrapperExecutable: true,
        wrapperChain: ["time", "busybox"],
      },
      name: "unwraps dispatch wrappers and shell multiplexers into one trust plan",
    },
    {
      argv: ["/usr/bin/script", "-q", "/dev/null", "sh", "-lc", "echo hi"],
      enabled: process.platform === "darwin" || process.platform === "freebsd",
      expected: {
        argv: ["sh", "-lc", "echo hi"],
        policyArgv: ["sh", "-lc", "echo hi"],
        policyBlocked: false,
        shellInlineCommand: "echo hi",
        shellWrapperExecutable: true,
        wrapperChain: ["script"],
      },
      name: "unwraps script wrappers before evaluating nested shell payloads",
    },
    {
      argv: ["/usr/bin/sandbox-exec", "-p", "(allow default)", "sh", "-lc", "echo hi"],
      enabled: process.platform !== "win32",
      expected: {
        argv: ["sh", "-lc", "echo hi"],
        policyArgv: ["sh", "-lc", "echo hi"],
        policyBlocked: false,
        shellInlineCommand: "echo hi",
        shellWrapperExecutable: true,
        wrapperChain: ["sandbox-exec"],
      },
      name: "unwraps sandbox-exec wrappers before evaluating nested shell payloads",
    },
    {
      argv: ["busybox", "sed", "-n", "1p"],
      enabled: true,
      expected: {
        argv: ["busybox", "sed", "-n", "1p"],
        blockedWrapper: "busybox",
        policyArgv: ["busybox", "sed", "-n", "1p"],
        policyBlocked: true,
        shellInlineCommand: null,
        shellWrapperExecutable: false,
        wrapperChain: [],
      },
      name: "fails closed for unsupported shell multiplexer applets",
    },
    {
      argv: ["nohup", "timeout", "5s", "busybox", "sh", "-lc", "echo hi"],
      depth: 2,
      enabled: true,
      expected: {
        argv: ["busybox", "sh", "-lc", "echo hi"],
        blockedWrapper: "busybox",
        policyArgv: ["busybox", "sh", "-lc", "echo hi"],
        policyBlocked: true,
        shellInlineCommand: null,
        shellWrapperExecutable: false,
        wrapperChain: ["nohup", "timeout"],
      },
      name: "fails closed when outer-wrapper depth overflows",
    },
    {
      argv: ["/usr/bin/time", "-p", "/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
      enabled: process.platform !== "win32",
      expected: {
        argv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
        blockedWrapper: "env",
        policyArgv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
        policyBlocked: true,
        shellInlineCommand: null,
        shellWrapperExecutable: false,
        wrapperChain: [],
      },
      name: "keeps the blocked dispatch argv as the policy target after transparent unwraps",
    },
  ])("$name", ({ enabled, argv, depth, expected }) => {
    if (!enabled) {
      return;
    }
    expect(resolveExecWrapperTrustPlan(argv, depth)).toEqual(expected);
  });
});
