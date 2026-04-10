import { describe, expect, it } from "vitest";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";

describe("parseExecApprovalResultText", () => {
  it("parses denied results", () => {
    expect(
      parseExecApprovalResultText("Exec denied (gateway id=req-1, approval-timeout): bash -lc ls"),
    ).toEqual({
      body: "bash -lc ls",
      kind: "denied",
      metadata: "gateway id=req-1, approval-timeout",
      raw: "Exec denied (gateway id=req-1, approval-timeout): bash -lc ls",
    });
  });

  it("parses finished results", () => {
    expect(
      parseExecApprovalResultText("Exec finished (gateway id=req-1, code 0)\nall good"),
    ).toEqual({
      body: "all good",
      kind: "finished",
      metadata: "gateway id=req-1, code 0",
      raw: "Exec finished (gateway id=req-1, code 0)\nall good",
    });
  });

  it("parses completed results", () => {
    expect(parseExecApprovalResultText("Exec completed: done")).toEqual({
      body: "done",
      kind: "completed",
      raw: "Exec completed: done",
    });
  });

  it("returns other for unmatched payloads", () => {
    expect(parseExecApprovalResultText("some random text")).toEqual({
      kind: "other",
      raw: "some random text",
    });
  });
});

describe("isExecDeniedResultText", () => {
  it.each([
    "Exec denied (gateway id=req-1, approval-timeout): uname -a",
    "exec denied (gateway id=req-1, approval-timeout): uname -a",
  ])("matches denied payloads: %s", (input) => {
    expect(isExecDeniedResultText(input)).toBe(true);
  });

  it("does not match non-denied payloads", () => {
    expect(isExecDeniedResultText("Exec finished (gateway id=req-1, code 0)")).toBe(false);
  });
});

describe("formatExecDeniedUserMessage", () => {
  it.each([
    [
      "Exec denied (gateway id=req-1, approval-timeout): uname -a",
      "Command did not run: approval timed out.",
    ],
    [
      "Exec denied (gateway id=req-1, user-denied): uname -a",
      "Command did not run: approval was denied.",
    ],
    [
      "Exec denied (gateway id=req-1, allowlist-miss): uname -a",
      "Command did not run: approval is required.",
    ],
    [
      "Exec denied (gateway id=req-1, approval-request-failed): uname -a",
      "Command did not run: approval request failed.",
    ],
    ["Exec denied (gateway id=req-1, spawn-failed): uname -a", "Command did not run."],
  ] as const)("maps denied metadata to safe copy", (input, expected) => {
    expect(formatExecDeniedUserMessage(input)).toBe(expected);
  });

  it("returns null for non-denied payloads", () => {
    expect(formatExecDeniedUserMessage("Exec finished (gateway id=req-1, code 0)")).toBeNull();
  });
});
