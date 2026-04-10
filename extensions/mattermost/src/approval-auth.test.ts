import { describe, expect, it } from "vitest";
import { mattermostApprovalAuth } from "./approval-auth.js";

describe("mattermostApprovalAuth", () => {
  it("authorizes stable Mattermost user ids and ignores usernames", () => {
    expect(
      mattermostApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg: {
          channels: { mattermost: { allowFrom: ["user:abcdefghijklmnopqrstuvwxyz"] } },
        },
        senderId: "abcdefghijklmnopqrstuvwxyz",
      }),
    ).toEqual({ authorized: true });

    expect(
      mattermostApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg: {
          channels: { mattermost: { allowFrom: ["@owner"] } },
        },
        senderId: "attacker-user-id",
      }),
    ).toEqual({ authorized: true });
  });
});
