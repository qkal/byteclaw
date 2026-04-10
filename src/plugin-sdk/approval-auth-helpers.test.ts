import { describe, expect, it } from "vitest";
import { createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers.js";

describe("createResolvedApproverActionAuthAdapter", () => {
  it.each([
    {
      cases: [
        {
          approvalKind: "exec" as const,
          expected: { authorized: true },
          senderId: "U_OWNER",
        },
      ],
      channelLabel: "Slack",
      name: "falls back to generic same-chat auth when no approvers resolve",
      normalizeSenderId: undefined,
      resolveApprovers: () => [],
    },
    {
      cases: [
        {
          approvalKind: "plugin" as const,
          expected: { authorized: true },
          senderId: " UUID:OWNER ",
        },
        {
          approvalKind: "plugin" as const,
          expected: {
            authorized: false,
            reason: "❌ You are not authorized to approve plugin requests on Signal.",
          },
          senderId: "uuid:attacker",
        },
      ],
      channelLabel: "Signal",
      name: "allows matching normalized approvers and rejects others",
      normalizeSenderId: (value: string) => value.trim().toLowerCase(),
      resolveApprovers: () => ["uuid:owner"],
    },
  ])("$name", ({ channelLabel, resolveApprovers, normalizeSenderId, cases }) => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel,
      normalizeSenderId,
      resolveApprovers,
    });

    for (const testCase of cases) {
      expect(
        auth.authorizeActorAction({
          action: "approve",
          approvalKind: testCase.approvalKind,
          cfg: {},
          senderId: testCase.senderId,
        }),
      ).toEqual(testCase.expected);
    }
  });
});
