import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { clearApprovalNativeRouteStateForTest } from "./approval-native-route-coordinator.js";
import {
  createChannelNativeApprovalRuntime,
  deliverApprovalRequestViaChannelNativePlan,
} from "./approval-native-runtime.js";

const execRequest = {
  createdAtMs: 0,
  expiresAtMs: 120_000,
  id: "approval-1",
  request: {
    command: "uname -a",
  },
};

afterEach(() => {
  clearApprovalNativeRouteStateForTest();
  vi.useRealTimers();
});

describe("deliverApprovalRequestViaChannelNativePlan", () => {
  it("dedupes converged prepared targets", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        notifyOriginWhenDmOnly: true,
        preferredSurface: "approver-dm",
        supportsApproverDmSurface: true,
        supportsOriginSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
      resolveOriginTarget: async () => ({ to: "origin-room" }),
    };
    const prepareTarget = vi
      .fn()
      .mockImplementation(
        async ({ plannedTarget }: { plannedTarget: { target: { to: string } } }) =>
          plannedTarget.target.to === "approver-1"
            ? {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-1" },
              }
            : {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-2" },
              },
      );
    const deliverTarget = vi
      .fn()
      .mockImplementation(
        async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => ({
          channelId: preparedTarget.channelId,
        }),
      );
    const onDuplicateSkipped = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      adapter,
      approvalKind: "exec",
      cfg: {} as never,
      deliverTarget,
      onDuplicateSkipped,
      prepareTarget,
      request: execRequest,
    });

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "shared-dm" }]);
    expect(result.deliveryPlan.notifyOriginWhenDmOnly).toBe(true);
  });

  it("continues after per-target delivery failures", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsApproverDmSurface: true,
        supportsOriginSurface: false,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const onDeliveryError = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      adapter,
      approvalKind: "exec",
      cfg: {} as never,
      deliverTarget: async ({ preparedTarget }) => {
        if (preparedTarget.channelId === "approver-1") {
          throw new Error("boom");
        }
        return { channelId: preparedTarget.channelId };
      },
      onDeliveryError,
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { channelId: plannedTarget.target.to },
      }),
      request: execRequest,
    });

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "approver-2" }]);
  });
});

describe("createChannelNativeApprovalRuntime", () => {
  it("passes the resolved approval kind and pending content through native delivery hooks", async () => {
    const describeDeliveryCapabilities = vi.fn().mockReturnValue({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsApproverDmSurface: true,
      supportsOriginSurface: false,
    });
    const resolveApproverDmTargets = vi
      .fn()
      .mockImplementation(({ approvalKind, accountId }) => [
        { to: `${approvalKind}:${accountId}` },
      ]);
    const buildPendingContent = vi.fn().mockResolvedValue("pending plugin");
    const prepareTarget = vi.fn().mockReturnValue({
      dedupeKey: "dm:plugin:secondary",
      target: { chatId: "plugin:secondary" },
    });
    const deliverTarget = vi
      .fn()
      .mockResolvedValue({ chatId: "plugin:secondary", messageId: "m1" });
    const finalizeResolved = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      accountId: "secondary",
      buildPendingContent,
      cfg: {} as never,
      channel: "telegram",
      channelLabel: "Telegram",
      clientDisplayName: "Test",
      deliverTarget,
      eventKinds: ["exec", "plugin"] as const,
      finalizeResolved,
      isConfigured: () => true,
      label: "test/native-runtime",
      nativeAdapter: {
        describeDeliveryCapabilities,
        resolveApproverDmTargets,
      },
      prepareTarget,
      shouldHandle: () => true,
    });

    await runtime.handleRequested({
      createdAtMs: 0,
      expiresAtMs: 60_000,
      id: "plugin:req-1",
      request: {
        description: "Allow access",
        title: "Plugin approval",
      },
    });
    await runtime.handleResolved({
      decision: "allow-once",
      id: "plugin:req-1",
      ts: 1,
    });

    expect(buildPendingContent).toHaveBeenCalledWith({
      approvalKind: "plugin",
      nowMs: expect.any(Number),
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(prepareTarget).toHaveBeenCalledWith({
      approvalKind: "plugin",
      pendingContent: "pending plugin",
      plannedTarget: {
        reason: "preferred",
        surface: "approver-dm",
        target: { to: "plugin:secondary" },
      },
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(deliverTarget).toHaveBeenCalledWith({
      approvalKind: "plugin",
      pendingContent: "pending plugin",
      plannedTarget: {
        reason: "preferred",
        surface: "approver-dm",
        target: { to: "plugin:secondary" },
      },
      preparedTarget: { chatId: "plugin:secondary" },
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(describeDeliveryCapabilities).toHaveBeenCalledWith({
      accountId: "secondary",
      approvalKind: "plugin",
      cfg: {} as never,
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(resolveApproverDmTargets).toHaveBeenCalledWith({
      accountId: "secondary",
      approvalKind: "plugin",
      cfg: {} as never,
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(finalizeResolved).toHaveBeenCalledWith({
      entries: [{ chatId: "plugin:secondary", messageId: "m1" }],
      request: expect.objectContaining({ id: "plugin:req-1" }),
      resolved: expect.objectContaining({ decision: "allow-once", id: "plugin:req-1" }),
    });
  });

  it("runs expiration through the shared runtime factory", async () => {
    vi.useFakeTimers();
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      buildPendingContent: async () => "pending exec",
      cfg: {} as never,
      channel: "telegram",
      channelLabel: "Telegram",
      clientDisplayName: "Test",
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeExpired,
      finalizeResolved: async () => {},
      isConfigured: () => true,
      label: "test/native-runtime-expiry",
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsApproverDmSurface: true,
          supportsOriginSurface: false,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      nowMs: Date.now,
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      shouldHandle: () => true,
    });

    await runtime.handleRequested({
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
      id: "req-1",
      request: {
        command: "echo hi",
      },
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(finalizeExpired).toHaveBeenCalledWith({
      entries: [{ chatId: "owner", messageId: "m1" }],
      request: expect.objectContaining({ id: "req-1" }),
    });
    vi.useRealTimers();
  });
});
