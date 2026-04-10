import { describe, expect, it } from "vitest";
import { BrowserValidationError, toBrowserErrorResponse } from "./errors.js";

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    err.name = "BlockedBrowserTargetError";

    expect(toBrowserErrorResponse(err)).toEqual({
      message: "Browser target is unavailable after SSRF policy blocked its navigation.",
      status: 409,
    });
  });

  it("preserves BrowserError mappings", () => {
    expect(toBrowserErrorResponse(new BrowserValidationError("bad input"))).toEqual({
      message: "bad input",
      status: 400,
    });
  });
});
