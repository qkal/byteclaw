import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INLINE_EVAL_HIT = {
  argv: ["python3", "-c", "print(1)"],
  executable: "python3",
  flag: "-c",
  normalizedExecutable: "python3",
};

const preparedPlan = vi.hoisted(() => ({
  agentId: "prepared-agent",
  argv: ["bun", "./script.ts"],
  commandPreview: "bun ./script.ts",
  commandText: "bun ./script.ts",
  cwd: "/tmp/work",
  mutableFileOperand: {
    argvIndex: 1,
    path: "/tmp/work/script.ts",
    sha256: "abc123",
  },
  sessionKey: "prepared-session",
}));

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const parsePreparedSystemRunPayloadMock = vi.hoisted(() => vi.fn());
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { agents: {}, version: 1 } },
    askFallback: "deny",
    hostAsk: "off",
    hostSecurity: "full",
  })),
);
const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null | undefined> => "allow-once"),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      approvedByAsk: false,
      baseDecision: { timedOut: false },
      deniedReason: null,
    }),
  ),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() => vi.fn(async () => undefined));
const enforceStrictInlineEvalApprovalBoundaryMock = vi.hoisted(() =>
  vi.fn(
    (value: {
      approvedByAsk: boolean;
      deniedReason: string | null;
    }): {
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => value,
  ),
);
const registerExecApprovalRequestForHostOrThrowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn(
    (): {
      executable: string;
      normalizedExecutable: string;
      flag: string;
      argv: string[];
    } | null => null,
  ),
);

vi.mock("../infra/exec-approvals.js", () => ({
  evaluateShellAllowlist: vi.fn(() => ({
    allowlistMatches: [],
    allowlistSatisfied: false,
    analysisOk: true,
    segmentAllowlistEntries: [],
    segments: [{ argv: ["bun", "./script.ts"], resolution: null }],
  })),
  hasDurableExecApproval: vi.fn(() => false),
  requiresExecApproval: requiresExecApprovalMock,
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  resolveExecApprovalsFromFile: vi.fn(() => ({
    allowlist: [],
    file: { agents: {}, version: 1 },
  })),
}));

vi.mock("../infra/exec-inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "inline-eval"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

vi.mock("../infra/node-shell.js", () => ({
  buildNodeShellCommand: vi.fn(() => ["bash", "-lc", "bun ./script.ts"]),
}));

vi.mock("../infra/system-run-approval-context.js", () => ({
  parsePreparedSystemRunPayload: parsePreparedSystemRunPayloadMock,
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostOrThrowMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildExecApprovalFollowupTarget: vi.fn(() => ({ approvalId: "approval-1" })),
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1000,
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value: string) => value),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: vi.fn(() => "node-1"),
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

let executeNodeHostCommand: typeof import("./bash-tools.exec-host-node.js").executeNodeHostCommand;

interface MockNodeInvokeParams {
  command?: string;
}

describe("executeNodeHostCommand", () => {
  beforeAll(async () => {
    ({ executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js"));
  });

  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method !== "node.invoke") {
          throw new Error(`unexpected gateway method: ${method}`);
        }
        if (params?.command === "system.run.prepare") {
          return { payload: { plan: preparedPlan } };
        }
        if (params?.command === "system.run") {
          return {
            payload: {
              exitCode: 0,
              stderr: "",
              stdout: "ok",
              success: true,
              timedOut: false,
            },
          };
        }
        throw new Error(`unexpected node invoke command: ${String(params?.command)}`);
      },
    );
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      { commands: ["system.run"], nodeId: "node-1", platform: process.platform },
    ]);
    parsePreparedSystemRunPayloadMock.mockReset();
    parsePreparedSystemRunPayloadMock.mockReturnValue({ plan: preparedPlan });
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(true);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { agents: {}, version: 1 } },
      askFallback: "deny",
      hostAsk: "off",
      hostSecurity: "full",
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockImplementation(async (args?: unknown) => {
      const register =
        args && typeof args === "object" && "register" in args
          ? (args as { register?: (approvalId: string) => Promise<void> }).register
          : undefined;
      await register?.("approval-1");
      return {
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        expiresAtMs: Date.now() + 60_000,
        initiatingSurface: "origin",
        preResolvedDecision: null,
        sentApproverDms: false,
        unavailableReason: null,
        warningText: "",
      };
    });
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      approvedByAsk: false,
      baseDecision: { timedOut: false },
      deniedReason: null,
    });
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation(
      (value: { approvedByAsk: boolean; deniedReason: string | null }) => value,
    );
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    registerExecApprovalRequestForHostOrThrowMock.mockReset();
  });

  it("forwards prepared systemRunPlan on async node invoke after approval", async () => {
    const result = await executeNodeHostCommand({
      agentId: "requested-agent",
      approvalRunningNoticeMs: 0,
      ask: "off",
      command: "bun ./script.ts",
      defaultTimeoutSec: 30,
      env: {},
      security: "full",
      sessionKey: "requested-session",
      warnings: [],
      workdir: "/tmp/work",
    });

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemRunPlan: preparedPlan,
      }),
    );

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    });

    expect(callGatewayToolMock).toHaveBeenNthCalledWith(
      2,
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        command: "system.run",
        params: expect.objectContaining({
          approvalDecision: "allow-once",
          approved: true,
          systemRunPlan: preparedPlan,
        }),
      }),
    );
  });

  it("denies timed-out inline-eval requests instead of invoking the node", async () => {
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      approvedByAsk: true,
      baseDecision: { timedOut: true },
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { agents: {}, version: 1 } },
      askFallback: "full",
      hostAsk: "off",
      hostSecurity: "full",
    });

    const result = await executeNodeHostCommand({
      agentId: "requested-agent",
      approvalRunningNoticeMs: 0,
      ask: "off",
      command: "python3 -c 'print(1)'",
      defaultTimeoutSec: 30,
      env: {},
      security: "full",
      sessionKey: "requested-session",
      strictInlineEval: true,
      warnings: [],
      workdir: "/tmp/work",
    });

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        { approvalId: "approval-1" },
        "Exec denied (node=node-1 id=approval-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });
});
