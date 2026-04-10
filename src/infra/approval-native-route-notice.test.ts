import { describe, expect, it } from "vitest";
import {
  describeApprovalDeliveryDestination,
  resolveApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";

describe("describeApprovalDeliveryDestination", () => {
  it("labels approver-DM-only delivery as channel DMs", () => {
    expect(
      describeApprovalDeliveryDestination({
        channelLabel: "Telegram",
        deliveredTargets: [
          {
            reason: "fallback",
            surface: "approver-dm",
            target: { to: "111" },
          },
        ],
      }),
    ).toBe("Telegram DMs");
  });

  it("labels mixed-surface delivery as the channel itself", () => {
    expect(
      describeApprovalDeliveryDestination({
        channelLabel: "Matrix",
        deliveredTargets: [
          {
            reason: "preferred",
            surface: "origin",
            target: { to: "room:!abc:example.com" },
          },
        ],
      }),
    ).toBe("Matrix");
  });
});

describe("resolveApprovalRoutedElsewhereNoticeText", () => {
  it("reports sorted unique destinations", () => {
    expect(
      resolveApprovalRoutedElsewhereNoticeText(["Telegram DMs", "Matrix DMs", "Telegram DMs"]),
    ).toBe(
      "Approval required. I sent the approval request to Matrix DMs or Telegram DMs, not this chat.",
    );
  });

  it("suppresses the notice when there are no destinations", () => {
    expect(resolveApprovalRoutedElsewhereNoticeText([])).toBeNull();
  });
});
