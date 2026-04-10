import { describe, expect, it } from "vitest";
import { formatRuntimeStatusWithDetails } from "./runtime-status.js";

describe("formatRuntimeStatusWithDetails", () => {
  it("falls back to unknown when status is missing", () => {
    expect(formatRuntimeStatusWithDetails({})).toBe("unknown");
    expect(formatRuntimeStatusWithDetails({ status: "   " })).toBe("unknown");
  });

  it("includes pid, distinct state, and non-empty details", () => {
    expect(
      formatRuntimeStatusWithDetails({
        details: ["healthy", "", "port 18789"],
        pid: 1234,
        state: "sleeping",
        status: "running",
      }),
    ).toBe("running (pid 1234, state sleeping, healthy, port 18789)");
  });

  it("trims distinct state and detail text before formatting", () => {
    expect(
      formatRuntimeStatusWithDetails({
        details: [" healthy ", "  port 18789  "],
        state: " sleeping ",
        status: "running",
      }),
    ).toBe("running (state sleeping, healthy, port 18789)");
  });

  it("omits duplicate state text and falsy pid values", () => {
    expect(
      formatRuntimeStatusWithDetails({
        details: [],
        pid: 0,
        state: "RUNNING",
        status: "running",
      }),
    ).toBe("running");
    expect(
      formatRuntimeStatusWithDetails({
        details: [],
        state: "running",
        status: " RUNNING ",
      }),
    ).toBe("RUNNING");
  });

  it("drops whitespace-only state and detail entries", () => {
    expect(
      formatRuntimeStatusWithDetails({
        details: ["", "   "],
        state: "   ",
        status: "running",
      }),
    ).toBe("running");
  });
});
