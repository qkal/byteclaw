import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions.js";
import { slackApprovalCapability, slackNativeApprovalAdapter } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>>,
): OpenClawConfig {
  return {
    channels: {
      slack: {
        appToken: "xapp-test",
        botToken: "xoxb-test",
        execApprovals: {
          approvers: ["U123APPROVER"],
          enabled: true,
          target: "both",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const STORE_PATH = path.join(os.tmpdir(), "openclaw-slack-approval-native-test.json");

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("slack native approval adapter", () => {
  it("keeps approval availability enabled when approvers exist but native delivery is off", () => {
    const cfg = buildConfig({
      execApprovals: {
        approvers: ["U123APPROVER"],
        enabled: false,
        target: "channel",
      },
    });

    expect(
      slackNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        accountId: "default",
        action: "approve",
        cfg,
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
        accountId: "default",
        approvalKind: "exec",
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-disabled-1",
          request: {
            command: "echo hi",
            sessionKey: "agent:main:slack:channel:c123",
            turnSourceAccountId: "default",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123",
          },
        },
      }),
    ).toEqual({
      enabled: false,
      notifyOriginWhenDmOnly: true,
      preferredSurface: "origin",
      supportsApproverDmSurface: true,
      supportsOriginSurface: true,
    });
  });

  it("describes native slack approval delivery capabilities", () => {
    const capabilities = slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:slack:channel:c123",
          turnSourceAccountId: "default",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
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

  it("describes the correct Slack exec-approval setup path", () => {
    const text = slackApprovalCapability.describeExecApprovalSetup?.({
      channel: "slack",
      channelLabel: "Slack",
    });

    expect(text).toContain("`channels.slack.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.slack.dm.allowFrom`");
  });

  it("describes the named-account Slack exec-approval setup path", () => {
    const text = slackApprovalCapability.describeExecApprovalSetup?.({
      accountId: "work",
      channel: "slack",
      channelLabel: "Slack",
    });

    expect(text).toContain("`channels.slack.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.slack.execApprovals.approvers`");
  });

  it("resolves origin targets from slack turn source", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
          turnSourceAccountId: "default",
          turnSourceChannel: "slack",
          turnSourceThreadId: "1712345678.123456",
          turnSourceTo: "channel:C123",
        },
      },
    });

    expect(target).toEqual({
      threadId: "1712345678.123456",
      to: "channel:C123",
    });
  });

  it("keeps origin delivery when session and turn source thread ids differ only by Slack timestamp precision", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
          turnSourceAccountId: "default",
          turnSourceChannel: "slack",
          turnSourceThreadId: "1712345678.123456",
          turnSourceTo: "channel:C123",
        },
      },
    });

    expect(target).toEqual({
      threadId: "1712345678.123456",
      to: "channel:C123",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
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

    expect(targets).toEqual([{ to: "user:U123APPROVER" }]);
  });

  it("falls back to the session-bound origin target for plugin approvals", async () => {
    writeStore({
      "agent:main:slack:channel:c123": {
        deliveryContext: {
          accountId: "default",
          channel: "slack",
          threadId: "1712345678.123456",
          to: "channel:C123",
        },
        sessionId: "sess",
        updatedAt: Date.now(),
      },
    });

    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "plugin",
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-1",
        request: {
          description: "Allow access",
          sessionKey: "agent:main:slack:channel:c123",
          title: "Plugin approval",
        },
      },
    });

    expect(target).toEqual({
      threadId: "1712345678.123456",
      to: "channel:C123",
    });
  });

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "plugin",
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "plugin:req-1",
        request: {
          description: "Allow access",
          sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
          title: "Plugin approval",
        },
      },
    });

    expect(target).toEqual({
      threadId: "1712345678.123456",
      to: "channel:C123",
    });
  });

  it("skips native delivery when agent filters do not match", async () => {
    const cfg = buildConfig({
      execApprovals: {
        agentFilter: ["ops-agent"],
        approvers: ["U123APPROVER"],
        enabled: true,
        target: "both",
      },
    });

    const originTarget = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg,
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          agentId: "other-agent",
          command: "echo hi",
          sessionKey: "agent:other-agent:slack:channel:c123",
          turnSourceAccountId: "default",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
        },
      },
    });
    const dmTargets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      accountId: "default",
      approvalKind: "exec",
      cfg,
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          agentId: "other-agent",
          command: "echo hi",
          sessionKey: "agent:other-agent:slack:channel:c123",
        },
      },
    });

    expect(originTarget).toBeNull();
    expect(dmTargets).toEqual([]);
  });

  it("skips native delivery when the request is bound to another Slack account", async () => {
    const originTarget = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:missing",
          turnSourceAccountId: "other",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
        },
      },
    });
    const dmTargets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      accountId: "default",
      approvalKind: "exec",
      cfg: buildConfig(),
      request: {
        createdAtMs: 0,
        expiresAtMs: 1000,
        id: "req-1",
        request: {
          command: "echo hi",
          sessionKey: "agent:main:missing",
          turnSourceAccountId: "other",
          turnSourceChannel: "slack",
        },
      },
    });

    expect(originTarget).toBeNull();
    expect(dmTargets).toEqual([]);
  });

  it("suppresses generic slack fallback only for slack-originated approvals", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      shouldSuppress({
        approvalKind: "exec",
        cfg: buildConfig(),
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "approval-1",
          request: {
            command: "echo hi",
            turnSourceAccountId: "default",
            turnSourceChannel: "slack",
          },
        },
        target: { accountId: "default", channel: "slack", to: "channel:C123ROOM" },
      }),
    ).toBe(true);

    expect(
      shouldSuppress({
        approvalKind: "exec",
        cfg: buildConfig(),
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "approval-1",
          request: {
            command: "echo hi",
            turnSourceAccountId: "default",
            turnSourceChannel: "discord",
          },
        },
        target: { accountId: "default", channel: "slack", to: "channel:C123ROOM" },
      }),
    ).toBe(false);
  });

  it("keeps plugin approval auth independent from exec approvers", () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: {
        approvers: ["U999EXEC"],
        enabled: true,
        target: "both",
      },
    });

    expect(
      slackNativeApprovalAdapter.auth.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "U123OWNER",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackNativeApprovalAdapter.auth.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "U999EXEC",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Slack.",
    });

    expect(
      slackNativeApprovalAdapter.auth.authorizeActorAction?.({
        accountId: "default",
        action: "approve",
        approvalKind: "exec",
        cfg,
        senderId: "U999EXEC",
      }),
    ).toEqual({ authorized: true });
  });
});
