import { describe, expect, it } from "vitest";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
} from "./approval-client-helpers.js";
import type { OpenClawConfig } from "./config-runtime.js";

describe("isChannelExecApprovalTargetRecipient", () => {
  it("matches targets by channel and account", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { accountId: "ops", channel: "matrix", to: "user:@owner:example.org" },
            { accountId: "other", channel: "matrix", to: "user:@other:example.org" },
          ],
        },
      },
    };

    expect(
      isChannelExecApprovalTargetRecipient({
        accountId: "ops",
        cfg,
        channel: "matrix",
        matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
        senderId: "@owner:example.org",
      }),
    ).toBe(true);

    expect(
      isChannelExecApprovalTargetRecipient({
        accountId: "other",
        cfg,
        channel: "matrix",
        matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
        senderId: "@owner:example.org",
      }),
    ).toBe(false);
  });

  it("normalizes the requested channel id before matching targets", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "matrix", to: "user:@owner:example.org" }],
        },
      },
    };

    expect(
      isChannelExecApprovalTargetRecipient({
        cfg,
        channel: " Matrix ",
        matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
        senderId: "@owner:example.org",
      }),
    ).toBe(true);
  });
});

describe("createChannelExecApprovalProfile", () => {
  const profile = createChannelExecApprovalProfile({
    isTargetRecipient: ({ senderId }) => senderId === "target",
    matchesRequestAccount: ({ accountId }) => accountId !== "other",
    resolveApprovers: () => ["owner"],
    resolveConfig: () => ({
      agentFilter: ["ops"],
      enabled: true,
      sessionFilter: ["tail$"],
      target: "channel",
    }),
  });

  it("treats unset enabled as auto and false as disabled", () => {
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 1,
      }),
    ).toBe(true);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 1,
        enabled: "auto",
      }),
    ).toBe(true);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 1,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 1,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 0,
      }),
    ).toBe(false);
  });

  it("reuses shared client, auth, and request-filter logic", () => {
    expect(profile.isClientEnabled({ cfg: {} })).toBe(true);
    expect(profile.isApprover({ cfg: {}, senderId: "owner" })).toBe(true);
    expect(profile.isAuthorizedSender({ cfg: {}, senderId: "target" })).toBe(true);
    expect(profile.resolveTarget({ cfg: {} })).toBe("channel");

    expect(
      profile.shouldHandleRequest({
        accountId: "ops",
        cfg: {},
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-1",
          request: {
            agentId: "ops",
            command: "echo hi",
            sessionKey: "agent:ops:telegram:direct:owner:tail",
          },
        },
      }),
    ).toBe(true);

    expect(
      profile.shouldHandleRequest({
        accountId: "other",
        cfg: {},
        request: {
          createdAtMs: 0,
          expiresAtMs: 1000,
          id: "req-1",
          request: {
            agentId: "ops",
            command: "echo hi",
            sessionKey: "agent:ops:telegram:direct:owner:tail",
          },
        },
      }),
    ).toBe(false);
  });

  it("supports local prompt suppression without requiring the client to be enabled", () => {
    const promptProfile = createChannelExecApprovalProfile({
      requireClientEnabledForLocalPromptSuppression: false,
      resolveApprovers: () => [],
      resolveConfig: () => undefined,
    });

    expect(
      promptProfile.shouldSuppressLocalPrompt({
        cfg: {},
        payload: {
          channelData: {
            execApproval: {
              approvalId: "req-1",
              approvalSlug: "req-1",
            },
          },
        },
      }),
    ).toBe(true);
  });
});
