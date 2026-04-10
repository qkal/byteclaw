import { describe, expect, test } from "vitest";
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { evaluateSystemRunApprovalMatch } from "./node-invoke-system-run-approval-match.js";

const defaultBinding = {
  agentId: null,
  cwd: null,
  sessionKey: null,
};

function expectMismatch(
  result: ReturnType<typeof evaluateSystemRunApprovalMatch>,
  code: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING",
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.code).toBe(code);
}

function expectV1BindingMatch(params: {
  argv: string[];
  requestCommand: string;
  commandArgv?: string[];
}) {
  const result = evaluateSystemRunApprovalMatch({
    argv: params.argv,
    binding: defaultBinding,
    request: {
      command: params.requestCommand,
      commandArgv: params.commandArgv,
      host: "node",
      systemRunBinding: buildSystemRunApprovalBinding({
        agentId: null,
        argv: params.argv,
        cwd: null,
        sessionKey: null,
      }).binding,
    },
  });
  expect(result).toEqual({ ok: true });
}

describe("evaluateSystemRunApprovalMatch", () => {
  test("rejects approvals that do not carry v1 binding", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      binding: defaultBinding,
      request: {
        command: "echo SAFE",
        host: "node",
      },
    });
    expectMismatch(result, "APPROVAL_REQUEST_MISMATCH");
  });

  test("enforces exact argv binding in v1 object", () => {
    expectV1BindingMatch({
      argv: ["echo", "SAFE"],
      requestCommand: "echo SAFE",
    });
  });

  test("rejects argv mismatch in v1 object", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      binding: defaultBinding,
      request: {
        command: "echo SAFE",
        host: "node",
        systemRunBinding: buildSystemRunApprovalBinding({
          agentId: null,
          argv: ["echo SAFE"],
          cwd: null,
          sessionKey: null,
        }).binding,
      },
    });
    expectMismatch(result, "APPROVAL_REQUEST_MISMATCH");
  });

  test("rejects env overrides when v1 binding has no env hash", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["git", "diff"],
      binding: {
        ...defaultBinding,
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
      },
      request: {
        command: "git diff",
        host: "node",
        systemRunBinding: buildSystemRunApprovalBinding({
          agentId: null,
          argv: ["git", "diff"],
          cwd: null,
          sessionKey: null,
        }).binding,
      },
    });
    expectMismatch(result, "APPROVAL_ENV_BINDING_MISSING");
  });

  test("accepts matching env hash with reordered keys", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["git", "diff"],
      binding: {
        ...defaultBinding,
        env: { SAFE_A: "1", SAFE_B: "2" },
      },
      request: {
        command: "git diff",
        host: "node",
        systemRunBinding: buildSystemRunApprovalBinding({
          agentId: null,
          argv: ["git", "diff"],
          cwd: null,
          env: { SAFE_A: "1", SAFE_B: "2" },
          sessionKey: null,
        }).binding,
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects mismatched Windows-compatible env override values", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["cmd.exe", "/c", "echo ok"],
      binding: {
        ...defaultBinding,
        env: { "ProgramFiles(x86)": String.raw`D:\malicious` },
      },
      request: {
        command: "cmd.exe /c echo ok",
        host: "node",
        systemRunBinding: buildSystemRunApprovalBinding({
          agentId: null,
          argv: ["cmd.exe", "/c", "echo ok"],
          cwd: null,
          env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
          sessionKey: null,
        }).binding,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_MISMATCH");
  });

  test("rejects non-node host requests", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      binding: defaultBinding,
      request: {
        command: "echo SAFE",
        host: "gateway",
      },
    });
    expectMismatch(result, "APPROVAL_REQUEST_MISMATCH");
  });

  test("uses v1 binding even when legacy command text diverges", () => {
    expectV1BindingMatch({
      argv: ["echo", "SAFE"],
      commandArgv: ["echo STALE"],
      requestCommand: "echo STALE",
    });
  });
});
