import { describe, expect, it } from "vitest";
import { buildMessagingTarget, ensureTargetId, requireTargetKind } from "./targets.js";

describe("channel targets", () => {
  it("ensureTargetId returns the candidate when it matches", () => {
    expect(
      ensureTargetId({
        candidate: "U123",
        errorMessage: "bad",
        pattern: /^[A-Z0-9]+$/i,
      }),
    ).toBe("U123");
  });

  it("ensureTargetId throws with the provided message on mismatch", () => {
    expect(() =>
      ensureTargetId({
        candidate: "not-ok",
        errorMessage: "Bad target",
        pattern: /^[A-Z0-9]+$/i,
      }),
    ).toThrow(/Bad target/);
  });

  it("requireTargetKind returns the target id when the kind matches", () => {
    const target = buildMessagingTarget("channel", "C123", "C123");
    expect(requireTargetKind({ kind: "channel", platform: "Slack", target })).toBe("C123");
  });

  it("requireTargetKind throws when the kind is missing or mismatched", () => {
    expect(() =>
      requireTargetKind({ kind: "channel", platform: "Slack", target: undefined }),
    ).toThrow(/Slack channel id is required/);
    const target = buildMessagingTarget("user", "U123", "U123");
    expect(() => requireTargetKind({ kind: "channel", platform: "Slack", target })).toThrow(
      /Slack channel id is required/,
    );
  });
});
