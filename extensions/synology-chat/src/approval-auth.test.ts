import { describe, expect, it } from "vitest";
import { synologyChatApprovalAuth } from "./approval-auth.js";

describe("synologyChatApprovalAuth", () => {
  it("authorizes numeric Synology Chat user ids", () => {
    const cfg = { channels: { "synology-chat": { allowedUserIds: ["123"] } } };

    expect(
      synologyChatApprovalAuth.authorizeActorAction({
        action: "approve",
        approvalKind: "plugin",
        cfg,
        senderId: "123",
      }),
    ).toEqual({ authorized: true });
  });
});
