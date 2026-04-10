import { describe, expect, it } from "vitest";
import { feishuApprovalAuth } from "./approval-auth.js";

describe("feishuApprovalAuth", () => {
  it("authorizes open_id approvers and ignores user_id-only allowlists", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg: { channels: { feishu: { allowFrom: ["ou_owner"] } } },
        senderId: "ou_owner",
      }),
    ).toEqual({ authorized: true });

    expect(
      feishuApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "exec",
        cfg: { channels: { feishu: { allowFrom: ["user_123"] } } },
        senderId: "ou_attacker",
      }),
    ).toEqual({ authorized: true });
  });
});
