import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApprovalOverGateway } from "./approval-gateway-resolver.js";

const hoisted = vi.hoisted(() => ({
  clientRequest: vi.fn(),
  clientStart: vi.fn(),
  clientStop: vi.fn(),
  clientStopAndWait: vi.fn(),
  createOperatorApprovalsGatewayClient: vi.fn(),
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: hoisted.createOperatorApprovalsGatewayClient,
}));

function createGatewayClient(params: {
  stopAndWaitRejects?: boolean;
  requestImpl?: typeof hoisted.clientRequest;
}) {
  const request = params.requestImpl ?? hoisted.clientRequest;
  return {
    request,
    start: () => {
      hoisted.clientStart();
    },
    stop: hoisted.clientStop,
    stopAndWait: params.stopAndWaitRejects
      ? vi.fn(async () => {
          hoisted.clientStopAndWait();
          throw new Error("close failed");
        })
      : vi.fn(async () => {
          hoisted.clientStopAndWait();
        }),
  };
}

describe("resolveApprovalOverGateway", () => {
  beforeEach(() => {
    hoisted.clientStart.mockReset();
    hoisted.clientStop.mockReset();
    hoisted.clientStopAndWait.mockReset();
    hoisted.clientRequest.mockReset().mockResolvedValue({ ok: true });
    hoisted.createOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (params) => {
      const client = createGatewayClient({});
      queueMicrotask(() => {
        params.onHelloOk?.({} as never);
      });
      return client;
    });
  });

  it("routes exec approvals through exec.approval.resolve", async () => {
    await resolveApprovalOverGateway({
      approvalId: "approval-1",
      cfg: { gateway: { auth: { token: "cfg-token" } } } as never,
      clientDisplayName: "Discord approval (default)",
      decision: "allow-once",
      gatewayUrl: "ws://gateway.example.test",
    });

    expect(hoisted.createOperatorApprovalsGatewayClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientDisplayName: "Discord approval (default)",
        config: { gateway: { auth: { token: "cfg-token" } } },
        gatewayUrl: "ws://gateway.example.test",
      }),
    );
    expect(hoisted.clientStart).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("exec.approval.resolve", {
      decision: "allow-once",
      id: "approval-1",
    });
    expect(hoisted.clientStopAndWait).toHaveBeenCalledTimes(1);
  });

  it("routes plugin approvals through plugin.approval.resolve", async () => {
    await resolveApprovalOverGateway({
      approvalId: "plugin:approval-1",
      cfg: {} as never,
      decision: "deny",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("plugin.approval.resolve", {
      decision: "deny",
      id: "plugin:approval-1",
    });
  });

  it("falls back to plugin.approval.resolve only for not-found exec approvals when enabled", async () => {
    const notFoundError = Object.assign(new Error("unknown or expired approval id"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    hoisted.clientRequest.mockRejectedValueOnce(notFoundError).mockResolvedValueOnce({ ok: true });

    await resolveApprovalOverGateway({
      allowPluginFallback: true,
      approvalId: "approval-1",
      cfg: {} as never,
      decision: "allow-always",
    });

    expect(hoisted.clientRequest.mock.calls).toEqual([
      ["exec.approval.resolve", { decision: "allow-always", id: "approval-1" }],
      ["plugin.approval.resolve", { decision: "allow-always", id: "approval-1" }],
    ]);
  });

  it("does not fall back for non-not-found exec approval failures", async () => {
    hoisted.clientRequest.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      resolveApprovalOverGateway({
        allowPluginFallback: true,
        approvalId: "approval-1",
        cfg: {} as never,
        decision: "deny",
      }),
    ).rejects.toThrow("permission denied");

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
  });

  it("falls back to stop when stopAndWait rejects", async () => {
    hoisted.createOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (params) => {
      const client = createGatewayClient({ stopAndWaitRejects: true });
      queueMicrotask(() => {
        params.onHelloOk?.({} as never);
      });
      return client;
    });

    await resolveApprovalOverGateway({
      approvalId: "approval-1",
      cfg: {} as never,
      decision: "allow-once",
    });

    expect(hoisted.clientStopAndWait).toHaveBeenCalledTimes(1);
    expect(hoisted.clientStop).toHaveBeenCalledTimes(1);
  });
});
