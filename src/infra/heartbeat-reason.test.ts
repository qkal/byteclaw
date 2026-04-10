import { describe, expect, it } from "vitest";
import {
  isHeartbeatActionWakeReason,
  isHeartbeatEventDrivenReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

describe("heartbeat-reason", () => {
  it.each([
    { expected: "cron:job-1", value: "  cron:job-1  " },
    { expected: "requested", value: "  " },
    { expected: "requested", value: undefined },
  ])("normalizes wake reasons for %j", ({ value, expected }) => {
    expect(normalizeHeartbeatWakeReason(value)).toBe(expected);
  });

  it.each([
    { expected: "retry", value: "retry" },
    { expected: "interval", value: "interval" },
    { expected: "manual", value: "manual" },
    { expected: "exec-event", value: "exec-event" },
    { expected: "wake", value: "wake" },
    { expected: "wake", value: "acp:spawn:stream" },
    { expected: "wake", value: "acp:spawn:" },
    { expected: "cron", value: "cron:job-1" },
    { expected: "hook", value: "hook:wake" },
    { expected: "hook", value: "  hook:wake  " },
    { expected: "other", value: "requested" },
    { expected: "other", value: "slow" },
    { expected: "other", value: "" },
    { expected: "other", value: undefined },
  ])("classifies reason kinds for %j", ({ value, expected }) => {
    expect(resolveHeartbeatReasonKind(value)).toBe(expected);
  });

  it.each([
    { expected: true, value: "exec-event" },
    { expected: true, value: "cron:job-1" },
    { expected: true, value: "wake" },
    { expected: true, value: "acp:spawn:stream" },
    { expected: true, value: "hook:gmail:sync" },
    { expected: false, value: "interval" },
    { expected: false, value: "manual" },
    { expected: false, value: "other" },
  ])("matches event-driven behavior for %j", ({ value, expected }) => {
    expect(isHeartbeatEventDrivenReason(value)).toBe(expected);
  });

  it.each([
    { expected: true, value: "manual" },
    { expected: true, value: "exec-event" },
    { expected: true, value: "hook:wake" },
    { expected: false, value: "interval" },
    { expected: false, value: "cron:job-1" },
    { expected: false, value: "retry" },
  ])("matches action-priority wake behavior for %j", ({ value, expected }) => {
    expect(isHeartbeatActionWakeReason(value)).toBe(expected);
  });
});
