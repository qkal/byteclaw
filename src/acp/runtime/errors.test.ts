import { describe, expect, it } from "vitest";
import { AcpRuntimeError, isAcpRuntimeError, withAcpRuntimeErrorBoundary } from "./errors.js";

describe("withAcpRuntimeErrorBoundary", () => {
  it("wraps generic errors with fallback code and source message", async () => {
    await expect(
      withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "boom",
      name: "AcpRuntimeError",
    });
  });

  it("passes through existing ACP runtime errors", async () => {
    const existing = new AcpRuntimeError("ACP_BACKEND_MISSING", "backend missing");
    await expect(
      withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
        run: async () => {
          throw existing;
        },
      }),
    ).rejects.toBe(existing);
  });

  it("preserves ACP runtime codes from foreign package errors", async () => {
    class ForeignAcpRuntimeError extends Error {
      readonly code = "ACP_BACKEND_MISSING" as const;
    }

    const foreignError = new ForeignAcpRuntimeError("backend missing");

    await expect(
      withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "fallback",
        run: async () => {
          throw foreignError;
        },
      }),
    ).rejects.toMatchObject({
      cause: foreignError,
      code: "ACP_BACKEND_MISSING",
      message: "backend missing",
      name: "AcpRuntimeError",
    });

    expect(isAcpRuntimeError(foreignError)).toBe(true);
  });
});
