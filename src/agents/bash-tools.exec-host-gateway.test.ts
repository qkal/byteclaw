import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const INLINE_EVAL_HIT = {
  argv: ["python3", "-c", "print(1)"],
  executable: "python3",
  flag: "-c",
  normalizedExecutable: "python3",
};

const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() => vi.fn());
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() => vi.fn(() => null));
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      approvedByAsk: false,
      baseDecision: { timedOut: false },
      deniedReason: "approval-required",
    }),
  ),
);
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowlistMatches: [],
    allowlistSatisfied: true,
    analysisOk: true,
    segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
    segments: [{ argv: ["echo", "ok"], resolution: null }],
  })),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn((): { ok: boolean; reason?: string; command?: string } => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
);
const recordAllowlistMatchesUseMock = vi.hoisted(() => vi.fn());
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null | undefined> => undefined),
);
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [], file: { agents: {}, version: 1 } },
    askFallback: "deny",
    hostAsk: "off",
    hostSecurity: "allowlist",
  })),
);
const runExecProcessMock = vi.hoisted(() => vi.fn());
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
  addAllowlistEntry: vi.fn(),
  addDurableCommandApproval: vi.fn(),
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  recordAllowlistMatchesUse: recordAllowlistMatchesUseMock,
  recordAllowlistUse: vi.fn(),
  requiresExecApproval: vi.fn(() => false),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  resolveApprovalAuditCandidatePath: vi.fn(() => null),
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
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
  normalizeNotifyOutput: vi.fn((value) => value),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", () => ({
  markBackgrounded: vi.fn(),
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/exec-inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReturnValue(null);
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      approvedByAsk: false,
      baseDecision: { timedOut: false },
      deniedReason: "approval-required",
    });
    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      allowlistSatisfied: true,
      analysisOk: true,
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      segments: [{ argv: ["echo", "ok"], resolution: null }],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    recordAllowlistMatchesUseMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { agents: {}, version: 1 } },
      askFallback: "deny",
      hostAsk: "off",
      hostSecurity: "allowlist",
    });
    runExecProcessMock.mockReset();
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation(
      (value: { approvedByAsk: boolean; deniedReason: string | null }) => value,
    );
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      expiresAtMs: Date.now() + 60_000,
      initiatingSurface: "origin",
      preResolvedDecision: null,
      sentApproverDms: false,
      unavailableReason: null,
      warningText: "",
    });
  });

  it("still requires approval when allowlist execution plan is unavailable despite durable trust", async () => {
    const result = await processGatewayAllowlist({
      approvalRunningNoticeMs: 0,
      ask: "off",
      command: "echo ok",
      defaultTimeoutSec: 30,
      env: process.env as Record<string, string>,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      pty: false,
      safeBinProfiles: {},
      safeBins: new Set(),
      security: "allowlist",
      warnings: [],
      workdir: process.cwd(),
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      allowlistSatisfied: false,
      analysisOk: false,
      segmentAllowlistEntries: [],
      segments: [{ argv: ["node", "--version"], resolution: null }],
    });
    hasDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({
      command: "node --version",
      ok: true,
    });

    const result = await processGatewayAllowlist({
      approvalRunningNoticeMs: 0,
      ask: "off",
      command: "node --version",
      defaultTimeoutSec: 30,
      env: process.env as Record<string, string>,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      pty: false,
      safeBinProfiles: {},
      safeBins: new Set(),
      security: "allowlist",
      warnings: [],
      workdir: process.cwd(),
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      allowlistSatisfied: false,
      analysisOk: false,
      segmentAllowlistEntries: [],
      segments: [{ argv: ["node", "--version"], resolution: null }],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);

    await expect(
      processGatewayAllowlist({
        approvalRunningNoticeMs: 0,
        ask: "off",
        command: "node --version",
        defaultTimeoutSec: 30,
        env: process.env as Record<string, string>,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        pty: false,
        safeBinProfiles: {},
        safeBins: new Set(),
        security: "allowlist",
        warnings: [],
        workdir: process.cwd(),
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("uses sessionKey for followups when notifySessionKey is absent", async () => {
    await processGatewayAllowlist({
      approvalRunningNoticeMs: 0,
      ask: "off",
      command: "echo ok",
      defaultTimeoutSec: 30,
      env: process.env as Record<string, string>,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      pty: false,
      safeBinProfiles: {},
      safeBins: new Set(),
      security: "allowlist",
      sessionKey: "agent:main:telegram:direct:123",
      warnings: [],
      workdir: process.cwd(),
    });

    expect(buildExecApprovalFollowupTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("denies timed-out inline-eval requests instead of auto-running them", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { agents: {}, version: 1 } },
      askFallback: "full",
      hostAsk: "always",
      hostSecurity: "full",
    });
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

    const result = await processGatewayAllowlist({
      approvalRunningNoticeMs: 0,
      ask: "always",
      command: "python3 -c 'print(1)'",
      defaultTimeoutSec: 30,
      env: process.env as Record<string, string>,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      pty: false,
      safeBinProfiles: {},
      safeBins: new Set(),
      security: "full",
      strictInlineEval: true,
      warnings: [],
      workdir: process.cwd(),
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("denies allowlist timeout fallback for strict inline-eval commands", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { agents: {}, version: 1 } },
      askFallback: "allowlist",
      hostAsk: "always",
      hostSecurity: "allowlist",
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      approvedByAsk: false,
      baseDecision: { timedOut: true },
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });

    const result = await processGatewayAllowlist({
      approvalRunningNoticeMs: 0,
      ask: "always",
      command: "python3 -c 'print(1)'",
      defaultTimeoutSec: 30,
      env: process.env as Record<string, string>,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      pty: false,
      safeBinProfiles: {},
      safeBins: new Set(),
      security: "allowlist",
      strictInlineEval: true,
      warnings: [],
      workdir: process.cwd(),
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        null,
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });
});
