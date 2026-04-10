import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it.each([
    {
      events: ["Cron: rotate logs"],
      expected: ["Cron: rotate logs", "Please relay this reminder to the user"],
      name: "builds user-relay cron prompt by default",
      unexpected: ["Handle this reminder internally", "Reply HEARTBEAT_OK."],
    },
    {
      events: ["Cron: rotate logs"],
      expected: ["Cron: rotate logs", "Handle this reminder internally"],
      name: "builds internal-only cron prompt when delivery is disabled",
      opts: { deliverToUser: false },
      unexpected: ["Please relay this reminder to the user"],
    },
    {
      events: ["", "   "],
      expected: ["Reply HEARTBEAT_OK."],
      name: "falls back to bare heartbeat reply when cron content is empty",
      unexpected: ["Handle this reminder internally"],
    },
    {
      events: ["", "   "],
      expected: ["Handle this internally", "HEARTBEAT_OK when nothing needs user-facing follow-up"],
      name: "uses internal empty-content fallback when delivery is disabled",
      opts: { deliverToUser: false },
      unexpected: ["Please relay this reminder to the user"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildCronEventPrompt(events, opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it.each([
    {
      expected: ["Please relay the command output to the user", "If it failed"],
      name: "builds user-relay exec prompt by default",
      opts: undefined,
      unexpected: ["Handle the result internally"],
    },
    {
      expected: ["Handle the result internally"],
      name: "builds internal-only exec prompt when delivery is disabled",
      opts: { deliverToUser: false },
      unexpected: ["Please relay the command output to the user"],
    },
  ])("$name", ({ opts, expected, unexpected }) => {
    const prompt = buildExecEventPrompt(opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });
});

describe("heartbeat event classification", () => {
  it.each([
    { expected: true, value: "exec finished: ok" },
    { expected: true, value: "Exec Finished: failed" },
    { expected: false, value: "cron finished" },
  ])("classifies exec completion events for %j", ({ value, expected }) => {
    expect(isExecCompletionEvent(value)).toBe(expected);
  });

  it.each([
    { expected: true, value: "Cron: rotate logs" },
    { expected: true, value: "  Cron: rotate logs  " },
    { expected: false, value: "" },
    { expected: false, value: "   " },
    { expected: false, value: "HEARTBEAT_OK" },
    { expected: false, value: "heartbeat_ok: already handled" },
    { expected: false, value: "heartbeat poll: noop" },
    { expected: false, value: "heartbeat wake: noop" },
    { expected: false, value: "exec finished: ok" },
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent(value)).toBe(expected);
  });
});
