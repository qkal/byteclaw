import { describe, expect, it } from "vitest";
import { resolveMatrixMonitorAccessState } from "./access-state.js";

describe("resolveMatrixMonitorAccessState", () => {
  it("normalizes effective allowlists once and exposes reusable matches", () => {
    const state = resolveMatrixMonitorAccessState({
      allowFrom: ["matrix:@Alice:Example.org"],
      groupAllowFrom: ["@Carol:Example.org"],
      isRoom: true,
      roomUsers: ["user:@Dana:Example.org"],
      senderId: "@dana:example.org",
      storeAllowFrom: ["user:@bob:example.org"],
    });

    expect(state.effectiveAllowFrom).toEqual([
      "matrix:@alice:example.org",
      "user:@bob:example.org",
    ]);
    expect(state.effectiveGroupAllowFrom).toEqual(["@carol:example.org"]);
    expect(state.effectiveRoomUsers).toEqual(["user:@dana:example.org"]);
    expect(state.directAllowMatch.allowed).toBe(false);
    expect(state.roomUserMatch?.allowed).toBe(true);
    expect(state.groupAllowMatch?.allowed).toBe(false);
    expect(state.commandAuthorizers).toEqual([
      { allowed: false, configured: true },
      { allowed: true, configured: true },
      { allowed: false, configured: true },
    ]);
  });

  it("keeps room-user matching disabled for dm traffic", () => {
    const state = resolveMatrixMonitorAccessState({
      allowFrom: [],
      groupAllowFrom: ["@carol:example.org"],
      isRoom: false,
      roomUsers: ["@dana:example.org"],
      senderId: "@dana:example.org",
      storeAllowFrom: [],
    });

    expect(state.roomUserMatch).toBeNull();
    expect(state.commandAuthorizers[1]).toEqual({ allowed: false, configured: true });
    expect(state.commandAuthorizers[2]).toEqual({ allowed: false, configured: true });
  });
});
