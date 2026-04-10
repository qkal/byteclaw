import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearApprovalNativeRouteStateForTest,
  createApprovalNativeRouteReporter,
} from "./approval-native-route-coordinator.js";

afterEach(() => {
  clearApprovalNativeRouteStateForTest();
});

function createGatewayRequestMock() {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    ok: true,
  })) as unknown as (<T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>) &
    ReturnType<typeof vi.fn>;
}

describe("createApprovalNativeRouteReporter", () => {
  it("caps route-notice cleanup timers to five minutes", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const requestGateway = createGatewayRequestMock();
      const reporter = createApprovalNativeRouteReporter({
        accountId: "default",
        channel: "slack",
        channelLabel: "Slack",
        handledKinds: new Set(["exec"]),
        requestGateway,
      });
      reporter.start();

      reporter.observeRequest({
        approvalKind: "exec",
        request: {
          createdAtMs: 0,
          expiresAtMs: Date.now() + 24 * 60 * 60_000,
          id: "approval-long",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123",
          },
        },
      });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait on runtimes that start after a request was already observed", async () => {
    const requestGateway = createGatewayRequestMock();
    const lateRuntimeGateway = createGatewayRequestMock();
    const request = {
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceAccountId: "default",
        turnSourceChannel: "slack",
        turnSourceThreadId: "1712345678.123456",
        turnSourceTo: "channel:C123",
      },
    } as const;

    const reporter = createApprovalNativeRouteReporter({
      accountId: "default",
      channel: "slack",
      channelLabel: "Slack",
      handledKinds: new Set(["exec"]),
      requestGateway,
    });
    reporter.start();
    reporter.observeRequest({
      approvalKind: "exec",
      request,
    });

    const lateReporter = createApprovalNativeRouteReporter({
      accountId: "default",
      channel: "slack",
      channelLabel: "Slack",
      handledKinds: new Set(["exec"]),
      requestGateway: lateRuntimeGateway,
    });
    lateReporter.start();

    await reporter.reportDelivery({
      approvalKind: "exec",
      deliveredTargets: [
        {
          reason: "preferred",
          surface: "approver-dm",
          target: {
            to: "user:owner",
          },
        },
      ],
      deliveryPlan: {
        notifyOriginWhenDmOnly: true,
        originTarget: {
          threadId: "1712345678.123456",
          to: "channel:C123",
        },
        targets: [],
      },
      request,
    });

    expect(requestGateway).toHaveBeenCalledWith("send", {
      accountId: "default",
      channel: "slack",
      idempotencyKey: "approval-route-notice:approval-1",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      threadId: "1712345678.123456",
      to: "channel:C123",
    });
    expect(lateRuntimeGateway).not.toHaveBeenCalled();
  });

  it("does not suppress the notice when another account delivered to the same target id", async () => {
    const originGateway = createGatewayRequestMock();
    const otherGateway = createGatewayRequestMock();
    const request = {
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
      id: "approval-2",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
      },
    } as const;

    const originReporter = createApprovalNativeRouteReporter({
      accountId: "work-a",
      channel: "slack",
      channelLabel: "Slack",
      handledKinds: new Set(["exec"]),
      requestGateway: originGateway,
    });
    const otherReporter = createApprovalNativeRouteReporter({
      accountId: "work-b",
      channel: "slack",
      channelLabel: "Slack",
      handledKinds: new Set(["exec"]),
      requestGateway: otherGateway,
    });
    originReporter.start();
    otherReporter.start();

    originReporter.observeRequest({
      approvalKind: "exec",
      request,
    });
    otherReporter.observeRequest({
      approvalKind: "exec",
      request,
    });

    await originReporter.reportDelivery({
      approvalKind: "exec",
      deliveredTargets: [
        {
          reason: "preferred",
          surface: "approver-dm",
          target: {
            to: "user:owner-a",
          },
        },
      ],
      deliveryPlan: {
        notifyOriginWhenDmOnly: true,
        originTarget: {
          to: "channel:C123",
        },
        targets: [],
      },
      request,
    });
    await otherReporter.reportDelivery({
      approvalKind: "exec",
      deliveredTargets: [
        {
          reason: "fallback",
          surface: "origin",
          target: {
            to: "channel:C123",
          },
        },
      ],
      deliveryPlan: {
        notifyOriginWhenDmOnly: true,
        originTarget: {
          to: "channel:C123",
        },
        targets: [],
      },
      request,
    });

    expect(originGateway).toHaveBeenCalledWith("send", {
      accountId: "work-a",
      channel: "slack",
      idempotencyKey: "approval-route-notice:approval-2",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      threadId: undefined,
      to: "channel:C123",
    });
    expect(otherGateway).not.toHaveBeenCalled();
  });
});
