import { describe, expect, it } from "vitest";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";

describe("buildChannelApprovalNativeTargetKey", () => {
  it("distinguishes targets whose parts contain colons", () => {
    const first = buildChannelApprovalNativeTargetKey({
      threadId: "$event:example.org",
      to: "!room:example.org",
    });
    const second = buildChannelApprovalNativeTargetKey({
      threadId: "example.org:$event:example.org",
      to: "!room",
    });

    expect(first).not.toBe(second);
  });

  it("normalizes surrounding whitespace", () => {
    expect(
      buildChannelApprovalNativeTargetKey({
        threadId: " 123 ",
        to: " room:one ",
      }),
    ).toBe(
      buildChannelApprovalNativeTargetKey({
        threadId: "123",
        to: "room:one",
      }),
    );
  });
});
