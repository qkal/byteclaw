import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "./exec-approval-command-display.js";

describe("sanitizeExecApprovalDisplayText", () => {
  it.each([
    ["echo hi\u200Bthere", String.raw`echo hi\u{200B}there`],
    ["date\u3164\uFFA0\u115F\u1160가", String.raw`date\u{3164}\u{FFA0}\u{115F}\u{1160}가`],
  ])("sanitizes exec approval display text for %j", (input, expected) => {
    expect(sanitizeExecApprovalDisplayText(input)).toBe(expected);
  });
});

describe("resolveExecApprovalCommandDisplay", () => {
  it.each([
    {
      expected: {
        commandPreview: null,
        commandText: "echo hi",
      },
      input: {
        command: "echo hi",
        commandPreview: "  echo hi  ",
        host: "gateway" as const,
      },
      name: "prefers explicit command fields and drops identical previews after trimming",
    },
    {
      expected: {
        commandPreview: "print\\u{200B}(1)",
        commandText: 'python3 -c "print(1)"',
      },
      input: {
        command: "",
        host: "node" as const,
        systemRunPlan: {
          agentId: null,
          argv: ["python3", "-c", "print(1)"],
          commandPreview: "print\u200B(1)",
          commandText: 'python3 -c "print(1)"',
          cwd: null,
          sessionKey: null,
        },
      },
      name: "falls back to node systemRunPlan values and sanitizes preview text",
    },
    {
      expected: {
        commandPreview: null,
        commandText: "",
      },
      input: {
        command: "",
        host: "sandbox" as const,
        systemRunPlan: {
          agentId: null,
          argv: ["echo", "hi"],
          commandPreview: "echo hi",
          commandText: "echo hi",
          cwd: null,
          sessionKey: null,
        },
      },
      name: "ignores systemRunPlan fallback for non-node hosts",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveExecApprovalCommandDisplay(input)).toEqual(expected);
  });
});
