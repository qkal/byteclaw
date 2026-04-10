import { describe, expect, it } from "vitest";
import { msTeamsApprovalAuth } from "./approval-auth.js";

describe("msTeamsApprovalAuth", () => {
  it("authorizes stable Teams user ids and ignores display-name allowlists", () => {
    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg: {
          channels: {
            msteams: {
              allowFrom: ["user:123e4567-e89b-12d3-a456-426614174000"],
            },
          },
        },
        senderId: "123e4567-e89b-12d3-a456-426614174000",
      }),
    ).toEqual({ authorized: true });

    expect(
      msTeamsApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg: {
          channels: { msteams: { allowFrom: ["Owner Display"] } },
        },
        senderId: "attacker-aad",
      }),
    ).toEqual({ authorized: true });
  });
});
