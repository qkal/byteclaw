import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveMatrixApproval", () => {
  beforeEach(() => {
    approvalRuntimeHoisted.resolveApprovalOverGatewaySpy.mockReset();
  });

  it("submits exec approval resolutions through the shared gateway resolver", async () => {
    const { resolveMatrixApproval } = await import("./exec-approval-resolver.js");

    await resolveMatrixApproval({
      approvalId: "req-123",
      cfg: {} as never,
      decision: "allow-once",
      senderId: "@owner:example.org",
    });

    expect(approvalRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      approvalId: "req-123",
      cfg: {} as never,
      clientDisplayName: "Matrix approval (@owner:example.org)",
      decision: "allow-once",
      gatewayUrl: undefined,
      senderId: "@owner:example.org",
    });
  });

  it("passes plugin approval ids through unchanged", async () => {
    const { resolveMatrixApproval } = await import("./exec-approval-resolver.js");

    await resolveMatrixApproval({
      approvalId: "plugin:req-123",
      cfg: {} as never,
      decision: "deny",
      senderId: "@owner:example.org",
    });

    expect(approvalRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      approvalId: "plugin:req-123",
      cfg: {} as never,
      clientDisplayName: "Matrix approval (@owner:example.org)",
      decision: "deny",
      gatewayUrl: undefined,
      senderId: "@owner:example.org",
    });
  });

  it("recognizes structured approval-not-found errors", async () => {
    const { isApprovalNotFoundError } = await import("./exec-approval-resolver.js");
    const err = new Error("approval not found");
    (err as Error & { gatewayCode?: string; details?: { reason?: string } }).gatewayCode =
      "INVALID_REQUEST";
    (err as Error & { gatewayCode?: string; details?: { reason?: string } }).details = {
      reason: "APPROVAL_NOT_FOUND",
    };

    expect(isApprovalNotFoundError(err)).toBe(true);
  });
});
