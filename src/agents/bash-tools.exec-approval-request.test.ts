import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let requestExecApprovalDecision: typeof import("./bash-tools.exec-approval-request.js").requestExecApprovalDecision;

describe("requestExecApprovalDecision", () => {
  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ requestExecApprovalDecision } = await import("./bash-tools.exec-approval-request.js"));
  });

  beforeEach(() => {
    vi.mocked(callGatewayTool).mockClear();
  });

  it("returns string decisions", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        id: "approval-id",
        status: "accepted",
      })
      .mockResolvedValueOnce({ decision: "allow-once" });

    const result = await requestExecApprovalDecision({
      agentId: "main",
      ask: "always",
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      id: "approval-id",
      resolvedPath: "/usr/bin/echo",
      security: "allowlist",
      sessionKey: "session",
      turnSourceAccountId: "work",
      turnSourceChannel: "whatsapp",
      turnSourceThreadId: "1739201675.123",
      turnSourceTo: "+15555550123",
    });

    expect(result).toBe("allow-once");
    expect(callGatewayTool).toHaveBeenCalledWith(
      "exec.approval.request",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      {
        agentId: "main",
        ask: "always",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        id: "approval-id",
        nodeId: undefined,
        resolvedPath: "/usr/bin/echo",
        security: "allowlist",
        sessionKey: "session",
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        turnSourceAccountId: "work",
        turnSourceChannel: "whatsapp",
        turnSourceThreadId: "1739201675.123",
        turnSourceTo: "+15555550123",
        twoPhase: true,
      },
      { expectFinal: false },
    );
    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id: "approval-id" },
    );
  });

  it("returns null for missing or non-string decisions", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ expiresAtMs: 1234, id: "approval-id", status: "accepted" })
      .mockResolvedValueOnce({});
    await expect(
      requestExecApprovalDecision({
        ask: "on-miss",
        command: "echo hi",
        cwd: "/tmp",
        host: "node",
        id: "approval-id",
        nodeId: "node-1",
        security: "allowlist",
      }),
    ).resolves.toBeNull();

    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ expiresAtMs: 1234, id: "approval-id-2", status: "accepted" })
      .mockResolvedValueOnce({ decision: 123 });
    await expect(
      requestExecApprovalDecision({
        ask: "on-miss",
        command: "echo hi",
        cwd: "/tmp",
        host: "node",
        id: "approval-id-2",
        nodeId: "node-1",
        security: "allowlist",
      }),
    ).resolves.toBeNull();
  });

  it("uses registration response id when waiting for decision", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        id: "server-assigned-id",
        status: "accepted",
      })
      .mockResolvedValueOnce({ decision: "allow-once" });

    await expect(
      requestExecApprovalDecision({
        ask: "on-miss",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        id: "client-id",
        security: "allowlist",
      }),
    ).resolves.toBe("allow-once");

    expect(callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id: "server-assigned-id" },
    );
  });

  it("treats expired-or-missing waitDecision as null decision", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        expiresAtMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        id: "approval-id",
        status: "accepted",
      })
      .mockRejectedValueOnce(new Error("approval expired or not found"));

    await expect(
      requestExecApprovalDecision({
        ask: "on-miss",
        command: "echo hi",
        cwd: "/tmp",
        host: "gateway",
        id: "approval-id",
        security: "allowlist",
      }),
    ).resolves.toBeNull();
  });

  it("returns final decision directly when gateway already replies with decision", async () => {
    vi.mocked(callGatewayTool).mockResolvedValue({ decision: "deny", id: "approval-id" });

    const result = await requestExecApprovalDecision({
      ask: "on-miss",
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      id: "approval-id",
      security: "allowlist",
    });

    expect(result).toBe("deny");
    expect(vi.mocked(callGatewayTool).mock.calls).toHaveLength(1);
  });
});
