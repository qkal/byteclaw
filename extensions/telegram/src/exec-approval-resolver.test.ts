import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalGatewayRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveTelegramExecApproval", () => {
  beforeEach(() => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("routes plugin approval ids through plugin.approval.resolve", async () => {
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      approvalId: "plugin:abc123",
      cfg: {} as never,
      decision: "allow-once",
      senderId: "9",
    });

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      allowPluginFallback: undefined,
      approvalId: "plugin:abc123",
      cfg: {} as never,
      clientDisplayName: "Telegram approval (9)",
      decision: "allow-once",
      gatewayUrl: undefined,
      senderId: "9",
    });
  });

  it("falls back to plugin.approval.resolve when exec approval ids are unknown", async () => {
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      allowPluginFallback: true,
      approvalId: "legacy-plugin-123",
      cfg: {} as never,
      decision: "allow-always",
      senderId: "9",
    });

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      allowPluginFallback: true,
      approvalId: "legacy-plugin-123",
      cfg: {} as never,
      clientDisplayName: "Telegram approval (9)",
      decision: "allow-always",
      gatewayUrl: undefined,
      senderId: "9",
    });
  });

  it("falls back to plugin.approval.resolve for structured approval-not-found errors", async () => {
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      allowPluginFallback: true,
      approvalId: "legacy-plugin-123",
      cfg: {} as never,
      decision: "allow-always",
      senderId: "9",
    });

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      allowPluginFallback: true,
      approvalId: "legacy-plugin-123",
      cfg: {} as never,
      clientDisplayName: "Telegram approval (9)",
      decision: "allow-always",
      gatewayUrl: undefined,
      senderId: "9",
    });
  });

  it("passes fallback disablement through unchanged", async () => {
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      approvalId: "legacy-plugin-123",
      cfg: {} as never,
      decision: "allow-always",
      senderId: "9",
    });

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      allowPluginFallback: undefined,
      approvalId: "legacy-plugin-123",
      cfg: {} as never,
      clientDisplayName: "Telegram approval (9)",
      decision: "allow-always",
      gatewayUrl: undefined,
      senderId: "9",
    });
  });
});
