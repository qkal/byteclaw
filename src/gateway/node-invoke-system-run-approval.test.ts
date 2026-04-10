import { describe, expect, test } from "vitest";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../infra/system-run-approval-binding.js";
import { ExecApprovalManager, type ExecApprovalRecord } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

describe("sanitizeSystemRunParamsForForwarding", () => {
  const now = Date.now();
  const client = {
    connId: "conn-1",
    connect: {
      client: { id: "cli-1" },
      device: { id: "dev-1" },
      scopes: ["operator.write", "operator.approvals"],
    },
  };

  function makeRecord(
    command: string,
    commandArgv?: string[],
    bindingArgv?: string[],
  ): ExecApprovalRecord {
    const effectiveBindingArgv = bindingArgv ?? commandArgv ?? [command];
    return {
      createdAtMs: now - 1000,
      decision: "allow-once",
      expiresAtMs: now + 60_000,
      id: "approval-1",
      request: {
        agentId: null,
        command,
        commandArgv,
        cwd: null,
        host: "node",
        nodeId: "node-1",
        sessionKey: null,
        systemRunBinding: buildSystemRunApprovalBinding({
          agentId: null,
          argv: effectiveBindingArgv,
          cwd: null,
          sessionKey: null,
        }).binding,
      },
      requestedByClientId: "cli-1",
      requestedByConnId: "conn-1",
      requestedByDeviceId: "dev-1",
      resolvedAtMs: now - 500,
      resolvedBy: "operator",
    };
  }

  function manager(record: ReturnType<typeof makeRecord>) {
    let consumed = false;
    return {
      consumeAllowOnce: () => {
        if (consumed || record.decision !== "allow-once") {
          return false;
        }
        consumed = true;
        record.decision = undefined;
        return true;
      },
      getSnapshot: () => record,
    };
  }

  function expectAllowOnceForwardingResult(
    result: ReturnType<typeof sanitizeSystemRunParamsForForwarding>,
  ) {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const params = result.params as Record<string, unknown>;
    expect(params.approved).toBe(true);
    expect(params.approvalDecision).toBe("allow-once");
  }

  function expectRejectedForwardingResult(
    result: ReturnType<typeof sanitizeSystemRunParamsForForwarding>,
    code: string,
    messageSubstring?: string,
  ) {
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    if (messageSubstring) {
      expect(result.message).toContain(messageSubstring);
    }
    expect(result.details?.code).toBe(code);
  }

  test("rejects cmd.exe /c trailing-arg mismatch against rawCommand", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord("echo")),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo",
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(
      result,
      "RAW_COMMAND_MISMATCH",
      "rawCommand does not match command",
    );
  });

  test("accepts matching cmd.exe /c command text for approval binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(
        makeRecord("echo SAFE&&whoami", undefined, [
          "cmd.exe",
          "/d",
          "/s",
          "/c",
          "echo",
          "SAFE&&whoami",
        ]),
      ),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["cmd.exe", "/d", "/s", "/c", "echo", "SAFE&&whoami"],
        rawCommand: "echo SAFE&&whoami",
        runId: "approval-1",
      },
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects env-assignment shell wrapper when approval command omits env prelude", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("accepts env-assignment shell wrapper only when approval command matches full argv text", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(
        makeRecord('/usr/bin/env BASH_ENV=/tmp/payload.sh bash -lc "echo SAFE"', undefined, [
          "/usr/bin/env",
          "BASH_ENV=/tmp/payload.sh",
          "bash",
          "-lc",
          "echo SAFE",
        ]),
      ),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["/usr/bin/env", "BASH_ENV=/tmp/payload.sh", "bash", "-lc", "echo SAFE"],
        runId: "approval-1",
      },
    });
    expectAllowOnceForwardingResult(result);
  });

  test("rejects trailing-space argv mismatch against legacy command-only approval", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord("runner")),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["runner "],
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("enforces commandArgv identity when approval includes argv binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord("echo SAFE", ["echo SAFE"])),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["echo", "SAFE"],
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(
      result,
      "APPROVAL_REQUEST_MISMATCH",
      "approval id does not match request",
    );
  });

  test("accepts matching commandArgv binding for trailing-space argv", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord('"runner "', ["runner "])),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["runner "],
        runId: "approval-1",
      },
    });
    expectAllowOnceForwardingResult(result);
  });

  test("uses systemRunPlan for forwarded command context and ignores caller tampering", () => {
    const record = makeRecord("echo SAFE", ["echo", "SAFE"]);
    record.request.systemRunPlan = {
      agentId: "main",
      argv: ["/usr/bin/echo", "SAFE"],
      commandText: "/usr/bin/echo SAFE",
      cwd: "/real/cwd",
      sessionKey: "agent:main:main",
    };
    record.request.systemRunBinding = buildSystemRunApprovalBinding({
      agentId: "main",
      argv: ["/usr/bin/echo", "SAFE"],
      cwd: "/real/cwd",
      sessionKey: "agent:main:main",
    }).binding;
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(record),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        agentId: "attacker",
        approvalDecision: "allow-once",
        approved: true,
        command: ["echo", "PWNED"],
        cwd: "/tmp/attacker-link/sub",
        rawCommand: "echo PWNED",
        runId: "approval-1",
        sessionKey: "agent:attacker:main",
      },
    });
    expectAllowOnceForwardingResult(result);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const forwarded = result.params as Record<string, unknown>;
    expect(forwarded.command).toEqual(["/usr/bin/echo", "SAFE"]);
    expect(forwarded.rawCommand).toBe("/usr/bin/echo SAFE");
    expect(forwarded.systemRunPlan).toEqual(
      expect.objectContaining({
        agentId: "main",
        argv: ["/usr/bin/echo", "SAFE"],
        commandText: "/usr/bin/echo SAFE",
        cwd: "/real/cwd",
        sessionKey: "agent:main:main",
      }),
    );
    expect(forwarded.cwd).toBe("/real/cwd");
    expect(forwarded.agentId).toBe("main");
    expect(forwarded.sessionKey).toBe("agent:main:main");
  });

  test("rejects env overrides when approval record lacks env binding", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord("git diff", ["git", "diff"])),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["git", "diff"],
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
        rawCommand: "git diff",
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(result, "APPROVAL_ENV_BINDING_MISSING");
  });

  test("rejects env hash mismatch", () => {
    const record = makeRecord("git diff", ["git", "diff"]);
    record.request.systemRunBinding = {
      agentId: null,
      argv: ["git", "diff"],
      cwd: null,
      envHash: buildSystemRunApprovalEnvBinding({ SAFE: "1" }).envHash,
      sessionKey: null,
    };
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(record),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["git", "diff"],
        env: { SAFE: "2" },
        rawCommand: "git diff",
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(result, "APPROVAL_ENV_MISMATCH");
  });

  test("consumes allow-once approvals and blocks same runId replay", async () => {
    const approvalManager = new ExecApprovalManager();
    const runId = "approval-replay-1";
    const record = approvalManager.create(
      {
        agentId: null,
        command: "echo SAFE",
        commandArgv: ["echo", "SAFE"],
        cwd: null,
        host: "node",
        nodeId: "node-1",
        sessionKey: null,
        systemRunBinding: buildSystemRunApprovalBinding({
          agentId: null,
          argv: ["echo", "SAFE"],
          cwd: null,
          sessionKey: null,
        }).binding,
      },
      60_000,
      runId,
    );
    record.requestedByConnId = "conn-1";
    record.requestedByDeviceId = "dev-1";
    record.requestedByClientId = "cli-1";

    const decisionPromise = approvalManager.register(record, 60_000);
    approvalManager.resolve(runId, "allow-once", "operator");
    await expect(decisionPromise).resolves.toBe("allow-once");

    const params = {
      approvalDecision: "allow-once",
      approved: true,
      command: ["echo", "SAFE"],
      rawCommand: "echo SAFE",
      runId,
    };

    const first = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: approvalManager,
      nodeId: "node-1",
      nowMs: now,
      rawParams: params,
    });
    expectAllowOnceForwardingResult(first);

    const second = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: approvalManager,
      nodeId: "node-1",
      nowMs: now,
      rawParams: params,
    });
    expectRejectedForwardingResult(second, "APPROVAL_REQUIRED");
  });

  test("rejects approval ids that do not bind a nodeId", () => {
    const record = makeRecord("echo SAFE");
    record.request.nodeId = null;
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(record),
      nodeId: "node-1",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["echo", "SAFE"],
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(result, "APPROVAL_NODE_BINDING_MISSING", "missing node binding");
  });

  test("rejects approval ids replayed against a different nodeId", () => {
    const result = sanitizeSystemRunParamsForForwarding({
      client,
      execApprovalManager: manager(makeRecord("echo SAFE")),
      nodeId: "node-2",
      nowMs: now,
      rawParams: {
        approvalDecision: "allow-once",
        approved: true,
        command: ["echo", "SAFE"],
        runId: "approval-1",
      },
    });
    expectRejectedForwardingResult(result, "APPROVAL_NODE_MISMATCH", "not valid for this node");
  });
});
