import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  getSlackExecApprovalApprovers,
  isSlackExecApprovalApprover,
  isSlackExecApprovalAuthorizedSender,
  isSlackExecApprovalClientEnabled,
  isSlackExecApprovalTargetRecipient,
  normalizeSlackApproverId,
  resolveSlackExecApprovalTarget,
  shouldHandleSlackExecApprovalRequest,
  shouldSuppressLocalSlackExecApprovalPrompt,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>>,
): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("slack exec approvals", () => {
  it("auto-enables when owner approvers resolve and disables only when forced off", () => {
    expect(isSlackExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ approvers: ["U123"] }),
      }),
    ).toBe(true);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: {
          ...buildConfig(),
          commands: { ownerAllowFrom: ["slack:U123OWNER"] },
        } as OpenClawConfig,
      }),
    ).toBe(true);
    expect(
      isSlackExecApprovalClientEnabled({
        cfg: buildConfig({ approvers: ["U123"], enabled: false }),
      }),
    ).toBe(false);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { approvers: ["U456"] },
      { allowFrom: ["U123"], defaultTo: "user:U789" },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U456"]);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U456" })).toBe(true);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U123" })).toBe(false);
  });

  it("does not infer approvers from allowFrom or DM default routes", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        allowFrom: ["slack:U123"],
        defaultTo: "user:U789",
        dm: { allowFrom: ["<@U456>"] },
      },
    );

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual([]);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U789" })).toBe(false);
  });

  it("falls back to commands.ownerAllowFrom for exec approvers", () => {
    const cfg = {
      ...buildConfig({ enabled: true }),
      commands: { ownerAllowFrom: ["slack:U123", "user:U456", "<@U789>"] },
    } as OpenClawConfig;

    expect(getSlackExecApprovalApprovers({ cfg })).toEqual(["U123", "U456", "U789"]);
    expect(isSlackExecApprovalApprover({ cfg, senderId: "U456" })).toBe(true);
  });

  it("defaults target to dm", () => {
    expect(
      resolveSlackExecApprovalTarget({ cfg: buildConfig({ approvers: ["U1"], enabled: true }) }),
    ).toBe("dm");
  });

  it("matches slack target recipients from generic approval forwarding targets", () => {
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "slack", to: "user:U123TARGET" },
            { channel: "slack", to: "channel:C123" },
          ],
        },
      },
      channels: {
        slack: {
          appToken: "xapp-test",
          botToken: "xoxb-test",
        },
      },
    } as OpenClawConfig;

    expect(isSlackExecApprovalTargetRecipient({ cfg, senderId: "U123TARGET" })).toBe(true);
    expect(isSlackExecApprovalTargetRecipient({ cfg, senderId: "U999OTHER" })).toBe(false);
    expect(isSlackExecApprovalAuthorizedSender({ cfg, senderId: "U123TARGET" })).toBe(true);
  });

  it("keeps the local Slack approval prompt path active", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
        },
      },
    };

    expect(
      shouldSuppressLocalSlackExecApprovalPrompt({
        cfg: buildConfig({ approvers: ["U123"], enabled: true }),
        payload,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalSlackExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
      }),
    ).toBe(false);
  });

  it("normalizes wrapped sender ids", () => {
    expect(normalizeSlackApproverId("user:U123OWNER")).toBe("U123OWNER");
    expect(normalizeSlackApproverId("<@U123OWNER>")).toBe("U123OWNER");
  });

  it("applies agent and session filters to request handling", () => {
    const cfg = buildConfig({
      agentFilter: ["ops-agent"],
      approvers: ["U123"],
      enabled: true,
      sessionFilter: ["slack:direct:", "tail$"],
    });

    expect(
      shouldHandleSlackExecApprovalRequest({
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-1",
          request: {
            agentId: "ops-agent",
            command: "echo hi",
            sessionKey: "agent:ops-agent:slack:direct:U123:tail",
          },
        },
      }),
    ).toBe(true);

    expect(
      shouldHandleSlackExecApprovalRequest({
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-2",
          request: {
            agentId: "other-agent",
            command: "echo hi",
            sessionKey: "agent:other-agent:slack:direct:U123:tail",
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldHandleSlackExecApprovalRequest({
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-3",
          request: {
            agentId: "ops-agent",
            command: "echo hi",
            sessionKey: "agent:ops-agent:discord:channel:123",
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects requests bound to another channel or Slack account", () => {
    const cfg = buildConfig({
      approvers: ["U123"],
      enabled: true,
    });

    expect(
      shouldHandleSlackExecApprovalRequest({
        accountId: "work",
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceAccountId: "work",
            turnSourceChannel: "discord",
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldHandleSlackExecApprovalRequest({
        accountId: "work",
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-2",
          request: {
            command: "echo hi",
            sessionKey: "agent:ops-agent:missing",
            turnSourceAccountId: "other",
            turnSourceChannel: "slack",
          },
        },
      }),
    ).toBe(false);

    expect(
      shouldHandleSlackExecApprovalRequest({
        accountId: "work",
        cfg,
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-3",
          request: {
            command: "echo hi",
            sessionKey: "agent:ops-agent:missing",
            turnSourceAccountId: "work",
            turnSourceChannel: "slack",
          },
        },
      }),
    ).toBe(true);
  });
});
