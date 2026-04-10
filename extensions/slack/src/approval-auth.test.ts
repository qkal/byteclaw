import { describe, expect, it } from "vitest";
import { slackApprovalAuth } from "./approval-auth.js";

describe("slackApprovalAuth", () => {
  it("authorizes general Slack approvers from allowFrom and defaultTo", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["slack:U123OWNER"],
          defaultTo: "user:U345DEFAULT",
          dm: { allowFrom: ["<@U234DM>"] },
          execApprovals: { approvers: ["user:U999EXEC"], enabled: true },
        },
      },
    };

    expect(
      slackApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg,
        senderId: "U123OWNER",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "U345DEFAULT",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalAuth.authorizeActorAction({
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
      slackApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg,
        senderId: "U999ATTACKER",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Slack.",
    });
  });
});
