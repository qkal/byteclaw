import { describe, expect, it } from "vitest";
import {
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
} from "./session-lifecycle-state.js";

describe("session lifecycle state", () => {
  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        event: {
          data: {
            phase: "start",
            startedAt: 900,
          },
          ts: 1000,
        },
        session: {
          abortedLastRun: true,
          endedAt: 400,
          runtimeMs: 300,
          startedAt: 100,
          status: "done",
          updatedAt: 500,
        },
      }),
    ).toEqual({
      abortedLastRun: false,
      endedAt: undefined,
      runtimeMs: undefined,
      startedAt: 900,
      status: "running",
      updatedAt: 900,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        event: {
          data: {
            endedAt: 1900,
            phase: "end",
            startedAt: 1200,
          },
          ts: 2000,
        },
        session: {
          startedAt: 1200,
          status: "running",
          updatedAt: 1000,
        },
      }),
    ).toEqual({
      abortedLastRun: false,
      endedAt: 1900,
      runtimeMs: 700,
      startedAt: 1200,
      status: "done",
      updatedAt: 1900,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          startedAt: 1100,
          updatedAt: 1000,
        },
        event: {
          data: {
            endedAt: 1800,
            phase: "end",
            stopReason: "aborted",
          },
          ts: 2000,
        },
      }),
    ).toEqual({
      abortedLastRun: true,
      endedAt: 1800,
      runtimeMs: 700,
      startedAt: 1100,
      status: "killed",
      updatedAt: 1800,
    });
  });

  it("maps aborted lifecycle end events without stopReason to timeout", () => {
    expect(
      derivePersistedSessionLifecyclePatch({
        entry: {
          startedAt: 1050,
          updatedAt: 1000,
        },
        event: {
          data: {
            aborted: true,
            endedAt: 1550,
            phase: "end",
          },
          ts: 2000,
        },
      }),
    ).toEqual({
      abortedLastRun: false,
      endedAt: 1550,
      runtimeMs: 500,
      startedAt: 1050,
      status: "timeout",
      updatedAt: 1550,
    });
  });
});
