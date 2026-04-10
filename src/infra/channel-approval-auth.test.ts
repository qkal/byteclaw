import { beforeEach, describe, expect, it, vi } from "vitest";

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  };
});

import { resolveApprovalCommandAuthorization } from "./channel-approval-auth.js";

describe("resolveApprovalCommandAuthorization", () => {
  beforeEach(() => {
    getChannelPluginMock.mockReset();
  });

  it("allows commands by default when the channel has no approval override", () => {
    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "slack",
        kind: "exec",
        senderId: "U123",
      }),
    ).toEqual({ authorized: true, explicit: false });
  });

  it("delegates to the channel approval override when present", () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: ({
          approvalKind,
        }: {
          action: "approve";
          approvalKind: "exec" | "plugin";
        }) =>
          approvalKind === "plugin"
            ? { authorized: false, reason: "plugin denied" }
            : { authorized: true },
      },
    });

    expect(
      resolveApprovalCommandAuthorization({
        accountId: "work",
        cfg: {} as never,
        channel: "discord",
        kind: "exec",
        senderId: "123",
      }),
    ).toEqual({ authorized: true, explicit: true });

    expect(
      resolveApprovalCommandAuthorization({
        accountId: "work",
        cfg: {} as never,
        channel: "discord",
        kind: "plugin",
        senderId: "123",
      }),
    ).toEqual({ authorized: false, explicit: true, reason: "plugin denied" });
  });

  it("uses approvalCapability as the canonical approval auth contract", () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: () => ({ authorized: true }),
        getActionAvailabilityState,
      },
    });

    expect(
      resolveApprovalCommandAuthorization({
        cfg: {} as never,
        channel: "matrix",
        kind: "exec",
        senderId: "123",
      }),
    ).toEqual({ authorized: true, explicit: true });
    expect(getActionAvailabilityState).toHaveBeenCalledWith({
      accountId: undefined,
      action: "approve",
      approvalKind: "exec",
      cfg: {} as never,
    });
  });

  it("keeps disabled approval availability implicit even when same-chat auth returns allow", () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "disabled" as const }));
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: () => ({ authorized: true }),
        getActionAvailabilityState,
      },
    });

    expect(
      resolveApprovalCommandAuthorization({
        accountId: "work",
        cfg: {} as never,
        channel: "slack",
        kind: "exec",
        senderId: "U123",
      }),
    ).toEqual({ authorized: true, explicit: false });
    expect(getActionAvailabilityState).toHaveBeenCalledWith({
      accountId: "work",
      action: "approve",
      approvalKind: "exec",
      cfg: {} as never,
    });
  });
});
