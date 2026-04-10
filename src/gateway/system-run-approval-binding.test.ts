import { describe, expect, test } from "vitest";
import { toSystemRunApprovalMismatchError } from "../infra/system-run-approval-binding.js";

describe("toSystemRunApprovalMismatchError", () => {
  test("includes runId/code and preserves mismatch details", () => {
    const result = toSystemRunApprovalMismatchError({
      match: {
        code: "APPROVAL_ENV_MISMATCH",
        details: {
          actualEnvHash: "actual-hash",
          envKeys: ["SAFE_A"],
          expectedEnvHash: "expected-hash",
        },
        message: "approval id env binding mismatch",
        ok: false,
      },
      runId: "approval-123",
    });
    expect(result).toEqual({
      details: {
        actualEnvHash: "actual-hash",
        code: "APPROVAL_ENV_MISMATCH",
        envKeys: ["SAFE_A"],
        expectedEnvHash: "expected-hash",
        runId: "approval-123",
      },
      message: "approval id env binding mismatch",
      ok: false,
    });
  });
});
