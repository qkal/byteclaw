import { describe, expect, it } from "vitest";
import { buildPayloads, expectSingleToolErrorPayload } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  it("suppresses exec tool errors when verbose mode is off", () => {
    expectNoPayloads({
      lastToolError: { error: "command failed", toolName: "exec" },
      verboseLevel: "off",
    });
  });

  it("surfaces exec tool errors for cron sessions even when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: {
        error:
          "Command timed out after 1800 seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).",
        timedOut: true,
        toolName: "exec",
      },
      sessionKey: "agent:main:cron:job-1",
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      detail:
        "Command timed out after 1800 seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).",
      title: "Exec",
    });
  });

  it("surfaces timed-out exec tool errors for cron-triggered custom session keys", () => {
    const payloads = buildPayloads({
      isCronTrigger: true,
      lastToolError: {
        error: "Command timed out after 1800 seconds.",
        timedOut: true,
        toolName: "exec",
      },
      sessionKey: "agent:main:project-alpha",
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      detail: "Command timed out after 1800 seconds.",
      title: "Exec",
    });
  });

  it("keeps non-timeout exec tool errors suppressed for cron sessions when verbose mode is off", () => {
    expectNoPayloads({
      lastToolError: { error: "Command not found", toolName: "exec" },
      sessionKey: "agent:main:cron:job-1",
      verboseLevel: "off",
    });
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { error: "command failed", toolName: "exec" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      detail: "command failed",
      title: "Exec",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { error: "permission denied", toolName: "write" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      absentDetail: "permission denied",
      title: "Write",
    });
  });

  it.each([
    {
      absentDetail: undefined,
      detail: "permission denied",
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
    },
    {
      absentDetail: undefined,
      detail: "permission denied",
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const payloads = buildPayloads({
      lastToolError: { error: "permission denied", toolName: "write" },
      verboseLevel,
    });

    expectSingleToolErrorPayload(payloads, {
      absentDetail,
      detail,
      title: "Write",
    });
  });

  it.each([
    {
      lastToolError: { error: "delivery timeout", toolName: "sessions_send" },
      name: "default relay failure",
    },
    {
      lastToolError: {
        error: "delivery timeout",
        mutatingAction: true,
        toolName: "sessions_send",
      },
      name: "mutating relay failure",
    },
  ])("suppresses sessions_send errors for $name", ({ lastToolError }) => {
    expectNoPayloads({
      lastToolError,
      verboseLevel: "on",
    });
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    expectNoPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });
  });

  it("suppresses JSON NO_REPLY assistant payloads", () => {
    expectNoPayloads({
      assistantTexts: ['{"action":"NO_REPLY"}'],
    });
  });
});
