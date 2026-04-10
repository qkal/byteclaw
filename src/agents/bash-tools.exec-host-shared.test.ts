import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveExecApprovals: vi.fn(() => ({
    agent: {
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
      security: "allowlist",
    },
    allowlist: [],
    defaults: {
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
      security: "allowlist",
    },
    file: { agents: {}, version: 1 },
  })),
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...mod,
    resolveExecApprovals: mocks.resolveExecApprovals,
  };
});

let sendExecApprovalFollowupResult: typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
let maxExecApprovalFollowupFailureLogKeys: typeof import("./bash-tools.exec-host-shared.js").MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS;
let enforceStrictInlineEvalApprovalBoundary: typeof import("./bash-tools.exec-host-shared.js").enforceStrictInlineEvalApprovalBoundary;
let resolveExecHostApprovalContext: typeof import("./bash-tools.exec-host-shared.js").resolveExecHostApprovalContext;
let resolveExecApprovalUnavailableState: typeof import("./bash-tools.exec-host-shared.js").resolveExecApprovalUnavailableState;
let buildExecApprovalPendingToolResult: typeof import("./bash-tools.exec-host-shared.js").buildExecApprovalPendingToolResult;

beforeAll(async () => {
  ({
    sendExecApprovalFollowupResult,
    MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS: maxExecApprovalFollowupFailureLogKeys,
    enforceStrictInlineEvalApprovalBoundary,
    resolveExecHostApprovalContext,
    resolveExecApprovalUnavailableState,
    buildExecApprovalPendingToolResult,
  } = await import("./bash-tools.exec-host-shared.js"));
});

describe("sendExecApprovalFollowupResult", () => {
  const sendExecApprovalFollowup = vi.fn();
  const logWarn = vi.fn();

  beforeEach(() => {
    sendExecApprovalFollowup.mockReset();
    logWarn.mockReset();
    mocks.resolveExecApprovals.mockReset();
    mocks.resolveExecApprovals.mockReturnValue({
      agent: {
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        security: "allowlist",
      },
      allowlist: [],
      defaults: {
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        security: "allowlist",
      },
      file: { agents: {}, version: 1 },
    });
  });

  it("logs repeated followup dispatch failures once per approval id and error message", async () => {
    sendExecApprovalFollowup.mockRejectedValue(new Error("Channel is required"));

    const target = {
      approvalId: "approval-log-once",
      sessionKey: "agent:main:main",
    };
    const deps = { logWarn, sendExecApprovalFollowup };
    await sendExecApprovalFollowupResult(target, "Exec finished", deps);
    await sendExecApprovalFollowupResult(target, "Exec finished", deps);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "exec approval followup dispatch failed (id=approval-log-once): Channel is required",
    );
  });

  it("evicts oldest followup failure dedupe keys after reaching the cap", async () => {
    sendExecApprovalFollowup.mockRejectedValue(new Error("Channel is required"));
    const deps = { logWarn, sendExecApprovalFollowup };

    for (let i = 0; i <= maxExecApprovalFollowupFailureLogKeys; i += 1) {
      await sendExecApprovalFollowupResult(
        {
          approvalId: `approval-${i}`,
          sessionKey: "agent:main:main",
        },
        "Exec finished",
        deps,
      );
    }
    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-0",
        sessionKey: "agent:main:main",
      },
      "Exec finished",
      deps,
    );

    expect(logWarn).toHaveBeenCalledTimes(maxExecApprovalFollowupFailureLogKeys + 2);
    expect(logWarn).toHaveBeenLastCalledWith(
      "exec approval followup dispatch failed (id=approval-0): Channel is required",
    );
  });
});

describe("resolveExecHostApprovalContext", () => {
  it("does not let exec-approvals.json broaden security beyond the requested policy", () => {
    mocks.resolveExecApprovals.mockReturnValue({
      agent: {
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        security: "full",
      },
      allowlist: [],
      defaults: {
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
        security: "allowlist",
      },
      file: { agents: {}, version: 1 },
    });

    const result = resolveExecHostApprovalContext({
      agentId: "agent-main",
      ask: "off",
      host: "gateway",
      security: "allowlist",
    });

    expect(result.hostSecurity).toBe("allowlist");
  });

  it("does not let host ask=off suppress a stricter requested ask mode", () => {
    mocks.resolveExecApprovals.mockReturnValue({
      agent: {
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
        security: "full",
      },
      allowlist: [],
      defaults: {
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
        security: "full",
      },
      file: { agents: {}, version: 1 },
    });

    const result = resolveExecHostApprovalContext({
      agentId: "agent-main",
      ask: "always",
      host: "gateway",
      security: "full",
    });

    expect(result.hostAsk).toBe("always");
  });

  it("clamps askFallback to the effective host security", () => {
    mocks.resolveExecApprovals.mockReturnValue({
      agent: {
        ask: "always",
        askFallback: "full",
        autoAllowSkills: false,
        security: "full",
      },
      allowlist: [],
      defaults: {
        ask: "always",
        askFallback: "full",
        autoAllowSkills: false,
        security: "full",
      },
      file: { agents: {}, version: 1 },
    });

    const result = resolveExecHostApprovalContext({
      agentId: "agent-main",
      ask: "always",
      host: "gateway",
      security: "allowlist",
    });

    expect(result.askFallback).toBe("allowlist");
  });
});

describe("enforceStrictInlineEvalApprovalBoundary", () => {
  it("denies timeout-based fallback when strict inline-eval approval is required", () => {
    expect(
      enforceStrictInlineEvalApprovalBoundary({
        approvedByAsk: true,
        baseDecision: { timedOut: true },
        deniedReason: null,
        requiresInlineEvalApproval: true,
      }),
    ).toEqual({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
  });

  it("keeps explicit approvals intact for strict inline-eval commands", () => {
    expect(
      enforceStrictInlineEvalApprovalBoundary({
        approvedByAsk: true,
        baseDecision: { timedOut: false },
        deniedReason: null,
        requiresInlineEvalApproval: true,
      }),
    ).toEqual({
      approvedByAsk: true,
      deniedReason: null,
    });
  });
});

describe("buildExecApprovalPendingToolResult", () => {
  it("does not infer approver DM delivery from unavailable approval state", () => {
    expect(
      resolveExecApprovalUnavailableState({
        preResolvedDecision: null,
        turnSourceAccountId: "default",
        turnSourceChannel: "telegram",
      }),
    ).toMatchObject({
      sentApproverDms: false,
      unavailableReason: "no-approval-route",
    });
  });

  it("keeps a local /approve prompt when the initiating Discord surface is disabled", () => {
    const result = buildExecApprovalPendingToolResult({
      allowedDecisions: ["allow-once", "deny"],
      approvalId: "approval-id",
      approvalSlug: "approval-slug",
      command: "npm view diver name version description",
      cwd: process.cwd(),
      expiresAtMs: Date.now() + 60_000,
      host: "gateway",
      initiatingSurface: {
        accountId: "default",
        channel: "discord",
        channelLabel: "Discord",
        kind: "disabled",
      },
      sentApproverDms: false,
      unavailableReason: null,
      warningText: "",
    });

    expect(result.details.status).toBe("approval-pending");
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("/approve approval-slug allow-once");
    expect(text).not.toContain("native chat exec approvals are not configured on Discord");
  });

  it("returns an unavailable reply when Discord exec approvals are disabled", () => {
    const result = buildExecApprovalPendingToolResult({
      approvalId: "approval-id",
      approvalSlug: "approval-slug",
      command: "npm view diver name version description",
      cwd: process.cwd(),
      expiresAtMs: Date.now() + 60_000,
      host: "gateway",
      initiatingSurface: {
        accountId: "default",
        channel: "discord",
        channelLabel: "Discord",
        kind: "disabled",
      },
      sentApproverDms: false,
      unavailableReason: "initiating-platform-disabled",
      warningText: "",
    });

    expect(result.details).toMatchObject({
      accountId: "default",
      channel: "discord",
      channelLabel: "Discord",
      host: "gateway",
      reason: "initiating-platform-disabled",
      status: "approval-unavailable",
    });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("native chat exec approvals are not configured on Discord");
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
  });

  it("keeps the Telegram unavailable reply when Discord DM approvals are not fully configured", () => {
    const result = buildExecApprovalPendingToolResult({
      approvalId: "approval-id",
      approvalSlug: "approval-slug",
      command: "npm view diver name version description",
      cwd: process.cwd(),
      expiresAtMs: Date.now() + 60_000,
      host: "gateway",
      initiatingSurface: {
        accountId: "default",
        channel: "telegram",
        channelLabel: "Telegram",
        kind: "disabled",
      },
      sentApproverDms: false,
      unavailableReason: "initiating-platform-disabled",
      warningText: "",
    });

    expect(result.details).toMatchObject({
      accountId: "default",
      channel: "telegram",
      channelLabel: "Telegram",
      host: "gateway",
      reason: "initiating-platform-disabled",
      sentApproverDms: false,
      status: "approval-unavailable",
    });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("native chat exec approvals are not configured on Telegram");
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
    expect(text).not.toContain("Approver DMs were sent");
  });
});
