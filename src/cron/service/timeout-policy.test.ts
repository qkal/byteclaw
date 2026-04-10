import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import {
  AGENT_TURN_SAFETY_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  resolveCronJobTimeoutMs,
} from "./timeout-policy.js";

function makeJob(payload: CronJob["payload"]): CronJob {
  const sessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
  return {
    createdAtMs: 0,
    enabled: true,
    id: "job-1",
    name: "job",
    payload,
    schedule: { everyMs: 60_000, kind: "every" },
    sessionTarget,
    state: {},
    updatedAtMs: 0,
    wakeMode: "next-heartbeat",
  };
}

describe("timeout-policy", () => {
  it("uses default timeout for non-agent jobs", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "systemEvent", text: "hello" }));
    expect(timeout).toBe(DEFAULT_JOB_TIMEOUT_MS);
  });

  it("uses expanded safety timeout for agentTurn jobs without explicit timeout", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "agentTurn", message: "hi" }));
    expect(timeout).toBe(AGENT_TURN_SAFETY_TIMEOUT_MS);
  });

  it("disables timeout when timeoutSeconds <= 0", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 0 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("applies explicit timeoutSeconds when positive", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 1.9 }),
    );
    expect(timeout).toBe(1900);
  });
});
