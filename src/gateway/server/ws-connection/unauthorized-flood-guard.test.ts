import { describe, expect, it } from "vitest";
import { ErrorCodes, errorShape } from "../../protocol/index.js";
import { UnauthorizedFloodGuard, isUnauthorizedRoleError } from "./unauthorized-flood-guard.js";

describe("UnauthorizedFloodGuard", () => {
  it("suppresses repeated unauthorized responses and closes after threshold", () => {
    const guard = new UnauthorizedFloodGuard({ closeAfter: 2, logEvery: 3 });

    const first = guard.registerUnauthorized();
    expect(first).toEqual({
      count: 1,
      shouldClose: false,
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });

    const second = guard.registerUnauthorized();
    expect(second).toEqual({
      count: 2,
      shouldClose: false,
      shouldLog: false,
      suppressedSinceLastLog: 0,
    });

    const third = guard.registerUnauthorized();
    expect(third).toEqual({
      count: 3,
      shouldClose: true,
      shouldLog: true,
      suppressedSinceLastLog: 1,
    });
  });

  it("resets counters", () => {
    const guard = new UnauthorizedFloodGuard({ closeAfter: 10, logEvery: 50 });
    guard.registerUnauthorized();
    guard.registerUnauthorized();
    guard.reset();

    const next = guard.registerUnauthorized();
    expect(next).toEqual({
      count: 1,
      shouldClose: false,
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });
  });
});

describe("isUnauthorizedRoleError", () => {
  it("detects unauthorized role responses", () => {
    expect(
      isUnauthorizedRoleError(errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized role: node")),
    ).toBe(true);
  });

  it("ignores non-role authorization errors", () => {
    expect(
      isUnauthorizedRoleError(
        errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin"),
      ),
    ).toBe(false);
    expect(isUnauthorizedRoleError(errorShape(ErrorCodes.UNAVAILABLE, "service unavailable"))).toBe(
      false,
    );
  });
});
