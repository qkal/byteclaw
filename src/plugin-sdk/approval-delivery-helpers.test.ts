import { describe, expect, it, vi } from "vitest";
import {
  createApproverRestrictedNativeApprovalAdapter,
  createApproverRestrictedNativeApprovalCapability,
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "./approval-delivery-helpers.js";

describe("createApproverRestrictedNativeApprovalAdapter", () => {
  it("uses approver-restricted authorization for exec and plugin commands", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "discord",
      channelLabel: "Discord",
      hasApprovers: ({ accountId }) => accountId === "work",
      isExecAuthorizedSender: ({ senderId }) => senderId === "exec-owner",
      isNativeDeliveryEnabled: () => true,
      isPluginAuthorizedSender: ({ senderId }) => senderId === "plugin-owner",
      listAccountIds: () => ["work"],
      resolveNativeDeliveryMode: () => "dm",
    });
    const {authorizeActorAction} = adapter.auth;
    if (!authorizeActorAction) {
      throw new Error("approval auth unavailable");
    }

    expect(
      authorizeActorAction({
        accountId: "work",
        action: "approve",
        approvalKind: "exec",
        cfg: {} as never,
        senderId: "exec-owner",
      }),
    ).toEqual({ authorized: true });

    expect(
      authorizeActorAction({
        accountId: "work",
        action: "approve",
        approvalKind: "plugin",
        cfg: {} as never,
        senderId: "plugin-owner",
      }),
    ).toEqual({ authorized: true });

    expect(
      authorizeActorAction({
        accountId: "work",
        action: "approve",
        approvalKind: "plugin",
        cfg: {} as never,
        senderId: "someone-else",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Discord.",
    });
  });

  it("reports initiating-surface state and DM routing from configured approvers", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      hasApprovers: ({ accountId }) => accountId !== "no-approvers",
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled: ({ accountId }) => accountId !== "disabled",
      listAccountIds: () => ["dm-only", "channel-only", "disabled", "no-approvers"],
      resolveApproverDmTargets: () => [{ to: "approver-1" }],
      resolveNativeDeliveryMode: ({ accountId }) =>
        accountId === "channel-only" ? "channel" : "dm",
      resolveOriginTarget: () => ({ to: "origin-chat" }),
    });
    const {getActionAvailabilityState} = adapter.auth;
    const {getExecInitiatingSurfaceState} = adapter.auth;
    const hasConfiguredDmRoute = adapter.delivery;
    if (
      !getActionAvailabilityState ||
      !getExecInitiatingSurfaceState ||
      !hasConfiguredDmRoute?.hasConfiguredDmRoute
    ) {
      throw new Error("approval availability helpers unavailable");
    }
    const nativeCapabilities = adapter.native?.describeDeliveryCapabilities({
      accountId: "channel-only",
      approvalKind: "exec",
      cfg: {} as never,
      request: {
        createdAtMs: 0,
        expiresAtMs: 10_000,
        id: "approval-1",
        request: { command: "pwd" },
      },
    });

    expect(
      getActionAvailabilityState({
        accountId: "dm-only",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      getActionAvailabilityState({
        accountId: "no-approvers",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual({ kind: "disabled" });
    expect(
      getActionAvailabilityState({
        accountId: "disabled",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      getExecInitiatingSurfaceState({
        accountId: "disabled",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual({ kind: "disabled" });
    expect(hasConfiguredDmRoute.hasConfiguredDmRoute({ cfg: {} as never })).toBe(true);
    expect(nativeCapabilities).toEqual({
      enabled: true,
      notifyOriginWhenDmOnly: false,
      preferredSurface: "origin",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });

  it("reports enabled when approvers exist even if native delivery is off (#59620)", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      hasApprovers: () => true,
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled: () => false,
      listAccountIds: () => ["default"],
      resolveNativeDeliveryMode: () => "both",
    });
    const {getActionAvailabilityState} = adapter.auth;
    const {getExecInitiatingSurfaceState} = adapter.auth;
    if (!getActionAvailabilityState || !getExecInitiatingSurfaceState) {
      throw new Error("approval availability helper unavailable");
    }

    expect(
      getActionAvailabilityState({
        accountId: "default",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      getExecInitiatingSurfaceState({
        accountId: "default",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("suppresses forwarding fallback only for matching native-delivery surfaces", () => {
    const isNativeDeliveryEnabled = vi.fn(
      ({ accountId }: { accountId?: string | null }) => accountId === "topic-1",
    );
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      hasApprovers: () => true,
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled,
      listAccountIds: () => [],
      requireMatchingTurnSourceChannel: true,
      resolveNativeDeliveryMode: () => "both",
      resolveSuppressionAccountId: ({ request }) =>
        request.request.turnSourceAccountId?.trim() || undefined,
    });
    const shouldSuppressForwardingFallback = adapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppressForwardingFallback) {
      throw new Error("delivery suppression helper unavailable");
    }

    expect(
      shouldSuppressForwardingFallback({
        approvalKind: "exec",
        cfg: {} as never,
        request: {
          request: {
            command: "pwd",
            turnSourceAccountId: " topic-1 ",
            turnSourceChannel: "telegram",
          },
        } as never,
        target: { channel: "telegram", to: "target-1" },
      }),
    ).toBe(true);

    expect(
      shouldSuppressForwardingFallback({
        approvalKind: "exec",
        cfg: {} as never,
        request: {
          request: {
            command: "pwd",
            turnSourceAccountId: "topic-1",
            turnSourceChannel: "slack",
          },
        } as never,
        target: { channel: "telegram", to: "target-1" },
      }),
    ).toBe(false);

    expect(
      shouldSuppressForwardingFallback({
        approvalKind: "exec",
        cfg: {} as never,
        request: {
          request: {
            command: "pwd",
            turnSourceAccountId: "topic-1",
            turnSourceChannel: "telegram",
          },
        } as never,
        target: { channel: "slack", to: "target-1" },
      }),
    ).toBe(false);

    expect(isNativeDeliveryEnabled).toHaveBeenCalledWith({
      accountId: "topic-1",
      cfg: {} as never,
    });

    expect(
      shouldSuppressForwardingFallback({
        approvalKind: "plugin",
        cfg: {} as never,
        request: {
          request: {
            command: "pwd",
            turnSourceAccountId: "topic-1",
            turnSourceChannel: "telegram",
          },
        } as never,
        target: { channel: "telegram", to: "target-1" },
      }),
    ).toBe(true);
  });
});

describe("createApproverRestrictedNativeApprovalCapability", () => {
  it("builds the canonical approval capability and preserves legacy split compatibility", () => {
    const nativeRuntime = {
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildExpiredResult: vi.fn(),
        buildPendingPayload: vi.fn(),
        buildResolvedResult: vi.fn(),
      },
      transport: {
        deliverPending: vi.fn(),
        prepareTarget: vi.fn(),
      },
    };
    const describeExecApprovalSetup = vi.fn(
      ({
        channel,
        channelLabel,
        accountId,
      }: {
        channel: string;
        channelLabel: string;
        accountId?: string;
      }) => `${channelLabel}:${channel}:${accountId ?? "default"}:setup`,
    );
    const capability = createApproverRestrictedNativeApprovalCapability({
      channel: "matrix",
      channelLabel: "Matrix",
      describeExecApprovalSetup,
      hasApprovers: () => true,
      isExecAuthorizedSender: ({ senderId }) => senderId === "@owner:example.com",
      isNativeDeliveryEnabled: () => true,
      listAccountIds: () => ["work"],
      nativeRuntime,
      resolveApproverDmTargets: () => [{ to: "user:@owner:example.com" }],
      resolveNativeDeliveryMode: () => "dm",
    });

    expect(
      capability.authorizeActorAction?.({
        accountId: "work",
        action: "approve",
        approvalKind: "exec",
        cfg: {} as never,
        senderId: "@owner:example.com",
      }),
    ).toEqual({ authorized: true });
    expect(capability.delivery?.hasConfiguredDmRoute?.({ cfg: {} as never })).toBe(true);
    expect(
      capability.describeExecApprovalSetup?.({
        accountId: "ops",
        channel: "matrix",
        channelLabel: "Matrix",
      }),
    ).toBe("Matrix:matrix:ops:setup");
    expect(
      capability.native?.describeDeliveryCapabilities({
        accountId: "work",
        approvalKind: "exec",
        cfg: {} as never,
        request: {
          createdAtMs: 0,
          expiresAtMs: 10_000,
          id: "approval-1",
          request: { command: "pwd" },
        },
      }),
    ).toEqual({
      enabled: true,
      notifyOriginWhenDmOnly: false,
      preferredSurface: "approver-dm",
      supportsApproverDmSurface: true,
      supportsOriginSurface: false,
    });

    const split = splitChannelApprovalCapability(capability);
    const legacy = createApproverRestrictedNativeApprovalAdapter({
      channel: "matrix",
      channelLabel: "Matrix",
      describeExecApprovalSetup,
      hasApprovers: () => true,
      isExecAuthorizedSender: ({ senderId }) => senderId === "@owner:example.com",
      isNativeDeliveryEnabled: () => true,
      listAccountIds: () => ["work"],
      resolveApproverDmTargets: () => [{ to: "user:@owner:example.com" }],
      resolveNativeDeliveryMode: () => "dm",
    });
    expect(split.delivery?.hasConfiguredDmRoute?.({ cfg: {} as never })).toBe(
      legacy.delivery?.hasConfiguredDmRoute?.({ cfg: {} as never }),
    );
    expect(
      split.native?.describeDeliveryCapabilities({
        accountId: "work",
        approvalKind: "exec",
        cfg: {} as never,
        request: {
          createdAtMs: 0,
          expiresAtMs: 10_000,
          id: "approval-1",
          request: { command: "pwd" },
        },
      }),
    ).toEqual(
      legacy.native?.describeDeliveryCapabilities({
        accountId: "work",
        approvalKind: "exec",
        cfg: {} as never,
        request: {
          createdAtMs: 0,
          expiresAtMs: 10_000,
          id: "approval-1",
          request: { command: "pwd" },
        },
      }),
    );
    expect(
      split.auth.authorizeActorAction?.({
        accountId: "work",
        action: "approve",
        approvalKind: "exec",
        cfg: {} as never,
        senderId: "@owner:example.com",
      }),
    ).toEqual(
      legacy.auth.authorizeActorAction?.({
        accountId: "work",
        action: "approve",
        approvalKind: "exec",
        cfg: {} as never,
        senderId: "@owner:example.com",
      }),
    );
    expect(
      split.auth.getExecInitiatingSurfaceState?.({
        accountId: "work",
        action: "approve",
        cfg: {} as never,
      }),
    ).toEqual(
      legacy.auth.getExecInitiatingSurfaceState?.({
        accountId: "work",
        action: "approve",
        cfg: {} as never,
      }),
    );
    expect(split.describeExecApprovalSetup).toBe(describeExecApprovalSetup);
    expect(split.nativeRuntime).toBe(nativeRuntime);
    expect(legacy.describeExecApprovalSetup).toBe(describeExecApprovalSetup);
  });
});

describe("createChannelApprovalCapability", () => {
  it("accepts canonical top-level capability surfaces", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = {
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildExpiredResult: vi.fn(),
        buildPendingPayload: vi.fn(),
        buildResolvedResult: vi.fn(),
      },
      transport: {
        deliverPending: vi.fn(),
        prepareTarget: vi.fn(),
      },
    };
    const render = {
      exec: {
        buildPendingPayload: vi.fn(),
      },
    };
    const native = { describeDeliveryCapabilities: vi.fn() };

    expect(
      createChannelApprovalCapability({
        delivery,
        native,
        nativeRuntime,
        render,
      }),
    ).toEqual({
      authorizeActorAction: undefined,
      delivery,
      describeExecApprovalSetup: undefined,
      getActionAvailabilityState: undefined,
      getExecInitiatingSurfaceState: undefined,
      native,
      nativeRuntime,
      render,
      resolveApproveCommandBehavior: undefined,
    });
  });

  it("keeps the deprecated approvals alias as a compatibility shim", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      createChannelApprovalCapability({
        approvals: { delivery },
      }),
    ).toEqual({
      authorizeActorAction: undefined,
      delivery,
      describeExecApprovalSetup: undefined,
      getActionAvailabilityState: undefined,
      getExecInitiatingSurfaceState: undefined,
      native: undefined,
      nativeRuntime: undefined,
      render: undefined,
      resolveApproveCommandBehavior: undefined,
    });
  });
});
