import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { matrixApprovalCapability } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        accessToken: "tok",
        execApprovals: {
          approvers: ["@owner:example.org"],
          enabled: true,
          target: "both",
        },
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

describe("matrix native approval adapter", () => {
  it("describes the correct Matrix exec-approval setup path", () => {
    const text = matrixApprovalCapability.describeExecApprovalSetup?.({
      channel: "matrix",
      channelLabel: "Matrix",
    });

    expect(text).toContain("`channels.matrix.execApprovals.approvers`");
    expect(text).toContain("`channels.matrix.dm.allowFrom`");
  });

  it("describes the named-account Matrix exec-approval setup path", () => {
    const text = matrixApprovalCapability.describeExecApprovalSetup?.({
      accountId: "work",
      channel: "matrix",
      channelLabel: "Matrix",
    });

    expect(text).toContain("`channels.matrix.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`channels.matrix.accounts.work.dm.allowFrom`");
    expect(text).not.toContain("`channels.matrix.execApprovals.approvers`");
  });

  it("describes native matrix approval delivery capabilities", () => {
    const capabilities = matrixApprovalCapability.native?.describeDeliveryCapabilities({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
          turnSourceAccountId: "default",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!ops:example.org",
        },
      },
    });

    expect(capabilities).toEqual({
      enabled: true,
      notifyOriginWhenDmOnly: true,
      preferredSurface: "both",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });

  it("resolves origin targets from matrix turn source", async () => {
    const target = await matrixApprovalCapability.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
          turnSourceAccountId: "default",
          turnSourceChannel: "matrix",
          turnSourceThreadId: "$thread",
          turnSourceTo: "room:!ops:example.org",
        },
      },
    });

    expect(target).toEqual({
      threadId: "$thread",
      to: "room:!ops:example.org",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await matrixApprovalCapability.native?.resolveApproverDmTargets?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
        },
      },
    });

    expect(targets).toEqual([{ to: "user:@owner:example.org" }]);
  });

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await matrixApprovalCapability.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "plugin",
      cfg: buildConfig({
        dm: { allowFrom: ["@owner:example.org"] },
      }),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-1",
        request: {
          description: "Allow plugin access",
          pluginId: "git-tools",
          sessionKey: "agent:main:matrix:channel:!ops:example.org:thread:$root",
          title: "Plugin Approval Required",
        },
      },
    });

    expect(target).toEqual({
      threadId: "$root",
      to: "room:!ops:example.org",
    });
  });

  it("suppresses same-channel plugin forwarding when Matrix native delivery is available", () => {
    const shouldSuppress = matrixApprovalCapability.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("delivery suppression helper unavailable");
    }

    expect(
      shouldSuppress({
        approvalKind: "plugin",
        cfg: buildConfig({
          dm: { allowFrom: ["@owner:example.org"] },
        }),
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "plugin:req-1",
          request: {
            description: "Allow plugin action",
            pluginId: "git-tools",
            title: "Plugin Approval Required",
            turnSourceAccountId: "default",
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!ops:example.org",
          },
        },
        target: {
          accountId: "default",
          channel: "matrix",
          to: "room:!ops:example.org",
        },
      } as never),
    ).toBe(true);
  });

  it("preserves room-id case when matching Matrix origin targets", async () => {
    const target = await matrixApprovalCapability.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:matrix:channel:!Ops:Example.org",
          turnSourceAccountId: "default",
          turnSourceChannel: "matrix",
          turnSourceThreadId: "$thread",
          turnSourceTo: "room:!Ops:Example.org",
        },
      },
    });

    expect(target).toEqual({
      threadId: "$thread",
      to: "room:!Ops:Example.org",
    });
  });

  it("keeps plugin approval auth independent from exec approvers", () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: {
        approvers: ["@exec:example.org"],
        enabled: true,
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "@owner:example.org",
      }),
    ).toEqual({ authorized: true });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "@exec:example.org",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Matrix.",
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
        cfg,
        senderId: "@exec:example.org",
      }),
    ).toEqual({ authorized: true });
  });

  it("requires Matrix DM approvers before enabling plugin approval auth", () => {
    const cfg = buildConfig({
      dm: { allowFrom: [] },
      execApprovals: {
        approvers: ["@exec:example.org"],
        enabled: true,
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "@exec:example.org",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
    });
  });

  it("reports exec initiating-surface availability independently from plugin auth", () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: {
        approvers: [],
        enabled: false,
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.getActionAvailabilityState?.({
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        cfg,
      }),
    ).toEqual({ kind: "enabled" });

    expect(
      matrixApprovalCapability.getExecInitiatingSurfaceState?.({
        accountId: "default",
        action: "approve",
        cfg,
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("enables matrix-native plugin approval delivery when DM approvers are configured", () => {
    const capabilities = matrixApprovalCapability.native?.describeDeliveryCapabilities({
      accountId: "default",
      approvalKind: "plugin",
      cfg: buildConfig({
        dm: { allowFrom: ["@owner:example.org"] },
      }),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-1",
        request: {
          description: "Allow plugin access",
          pluginId: "git-tools",
          title: "Plugin Approval Required",
        },
      },
    });

    expect(capabilities).toEqual({
      enabled: true,
      notifyOriginWhenDmOnly: true,
      preferredSurface: "both",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });

  it("keeps matrix-native plugin approval delivery disabled without DM approvers", () => {
    const capabilities = matrixApprovalCapability.native?.describeDeliveryCapabilities({
      accountId: "default",
      approvalKind: "plugin",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-1",
        request: {
          description: "Allow plugin access",
          pluginId: "git-tools",
          title: "Plugin Approval Required",
        },
      },
    });

    expect(capabilities).toEqual({
      enabled: false,
      notifyOriginWhenDmOnly: true,
      preferredSurface: "both",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });
});
