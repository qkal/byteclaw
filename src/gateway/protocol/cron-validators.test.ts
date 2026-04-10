import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronUpdateParams,
} from "./index.js";

const minimalAddParams = {
  name: "daily-summary",
  payload: { kind: "systemEvent", text: "tick" },
  schedule: { everyMs: 60_000, kind: "every" },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
} as const;

describe("cron protocol validators", () => {
  it("accepts minimal add params", () => {
    expect(validateCronAddParams(minimalAddParams)).toBe(true);
  });

  it("accepts current and custom session targets", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        payload: { kind: "agentTurn", message: "tick" },
        sessionTarget: "current",
      }),
    ).toBe(true);
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        payload: { kind: "agentTurn", message: "tick" },
        sessionTarget: "session:project-alpha",
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { sessionTarget: "session:project-alpha" },
      }),
    ).toBe(true);
  });

  it("rejects add params when required scheduling fields are missing", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expect(validateCronAddParams(withoutWakeMode)).toBe(false);
  });

  it("accepts update params for id and jobId selectors", () => {
    expect(validateCronUpdateParams({ id: "job-1", patch: { enabled: false } })).toBe(true);
    expect(validateCronUpdateParams({ jobId: "job-2", patch: { enabled: true } })).toBe(true);
  });

  it("accepts remove params for id and jobId selectors", () => {
    expect(validateCronRemoveParams({ id: "job-1" })).toBe(true);
    expect(validateCronRemoveParams({ jobId: "job-2" })).toBe(true);
  });

  it("accepts run params mode for id and jobId selectors", () => {
    expect(validateCronRunParams({ id: "job-1", mode: "force" })).toBe(true);
    expect(validateCronRunParams({ jobId: "job-2", mode: "due" })).toBe(true);
  });

  it("accepts list paging/filter/sort params", () => {
    expect(
      validateCronListParams({
        enabled: "all",
        includeDisabled: true,
        limit: 50,
        offset: 0,
        query: "daily",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      }),
    ).toBe(true);
    expect(validateCronListParams({ offset: -1 })).toBe(false);
  });

  it("enforces runs limit minimum for id and jobId selectors", () => {
    expect(validateCronRunsParams({ id: "job-1", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", limit: 0 })).toBe(false);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 0 })).toBe(false);
  });

  it("rejects cron.runs path traversal ids", () => {
    expect(validateCronRunsParams({ id: "../job-1" })).toBe(false);
    expect(validateCronRunsParams({ id: "nested/job-1" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "..\\job-2" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "nested\\job-2" })).toBe(false);
  });

  it("accepts runs paging/filter/sort params", () => {
    expect(
      validateCronRunsParams({
        id: "job-1",
        limit: 50,
        offset: 0,
        query: "timeout",
        sortDir: "desc",
        status: "error",
      }),
    ).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", offset: -1 })).toBe(false);
  });

  it("accepts all-scope runs with multi-select filters", () => {
    expect(
      validateCronRunsParams({
        deliveryStatuses: ["delivered", "not-requested"],
        limit: 25,
        query: "fail",
        scope: "all",
        sortDir: "desc",
        statuses: ["ok", "error"],
      }),
    ).toBe(true);
    expect(
      validateCronRunsParams({
        scope: "job",
        statuses: [],
      }),
    ).toBe(false);
  });
});
