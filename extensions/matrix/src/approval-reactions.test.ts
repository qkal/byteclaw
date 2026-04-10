import { afterEach, describe, expect, it } from "vitest";
import {
  buildMatrixApprovalReactionHint,
  clearMatrixApprovalReactionTargetsForTest,
  listMatrixApprovalReactionBindings,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTarget,
  unregisterMatrixApprovalReactionTarget,
} from "./approval-reactions.js";

afterEach(() => {
  clearMatrixApprovalReactionTargetsForTest();
});

describe("matrix approval reactions", () => {
  it("lists reactions in stable decision order", () => {
    expect(listMatrixApprovalReactionBindings(["allow-once", "deny", "allow-always"])).toEqual([
      { decision: "allow-once", emoji: "✅", label: "Allow once" },
      { decision: "allow-always", emoji: "♾️", label: "Allow always" },
      { decision: "deny", emoji: "❌", label: "Deny" },
    ]);
  });

  it("builds a compact reaction hint", () => {
    expect(buildMatrixApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React here: ✅ Allow once, ❌ Deny",
    );
  });

  it("resolves a registered approval anchor event back to an approval decision", () => {
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });

    expect(
      resolveMatrixApprovalReactionTarget({
        eventId: "$approval-msg",
        reactionKey: "✅",
        roomId: "!ops:example.org",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "allow-once",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        eventId: "$approval-msg",
        reactionKey: "♾️",
        roomId: "!ops:example.org",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "allow-always",
    });
    expect(
      resolveMatrixApprovalReactionTarget({
        eventId: "$approval-msg",
        reactionKey: "❌",
        roomId: "!ops:example.org",
      }),
    ).toEqual({
      approvalId: "req-123",
      decision: "deny",
    });
  });

  it("ignores reactions that are not allowed on the registered approval anchor event", () => {
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["allow-once", "deny"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });

    expect(
      resolveMatrixApprovalReactionTarget({
        eventId: "$approval-msg",
        reactionKey: "♾️",
        roomId: "!ops:example.org",
      }),
    ).toBeNull();
  });

  it("stops resolving reactions after the approval anchor event is unregistered", () => {
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });
    unregisterMatrixApprovalReactionTarget({
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });

    expect(
      resolveMatrixApprovalReactionTarget({
        eventId: "$approval-msg",
        reactionKey: "✅",
        roomId: "!ops:example.org",
      }),
    ).toBeNull();
  });
});
