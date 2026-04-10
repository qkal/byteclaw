import { describe, expect, it } from "vitest";
import {
  formatConfigIssueLine,
  formatConfigIssueLines,
  normalizeConfigIssue,
  normalizeConfigIssuePath,
  normalizeConfigIssues,
} from "./issue-format.js";

describe("config issue format", () => {
  it("normalizes empty paths to <root>", () => {
    expect(normalizeConfigIssuePath("")).toBe("<root>");
    expect(normalizeConfigIssuePath("   ")).toBe("<root>");
    expect(normalizeConfigIssuePath(null)).toBe("<root>");
    expect(normalizeConfigIssuePath(undefined)).toBe("<root>");
  });

  it("formats issue lines with and without markers", () => {
    expect(formatConfigIssueLine({ message: "broken", path: "" }, "-")).toBe("- : broken");
    expect(
      formatConfigIssueLine({ message: "broken", path: "" }, "-", { normalizeRoot: true }),
    ).toBe("- <root>: broken");
    expect(formatConfigIssueLine({ message: "invalid", path: "gateway.bind" }, "")).toBe(
      "gateway.bind: invalid",
    );
    expect(
      formatConfigIssueLines(
        [
          { message: "first", path: "" },
          { message: "second", path: "channels.signal.dmPolicy" },
        ],
        "×",
        { normalizeRoot: true },
      ),
    ).toEqual(["× <root>: first", "× channels.signal.dmPolicy: second"]);
  });

  it("sanitizes control characters and ANSI sequences in formatted lines", () => {
    expect(
      formatConfigIssueLine(
        {
          message: "bad\r\n\tvalue\x1b[0m\u0007",
          path: "gateway.\nbind\x1b[31m",
        },
        "-",
      ),
    ).toBe(String.raw`- gateway.\nbind: bad\r\n\tvalue`);
  });

  it("normalizes issue metadata for machine output", () => {
    expect(
      normalizeConfigIssue({
        allowedValues: ["stable", "beta"],
        allowedValuesHiddenCount: 0,
        message: "invalid",
        path: "",
      }),
    ).toEqual({
      allowedValues: ["stable", "beta"],
      message: "invalid",
      path: "<root>",
    });

    expect(
      normalizeConfigIssues([
        {
          allowedValues: [],
          allowedValuesHiddenCount: 2,
          message: "invalid",
          path: "update.channel",
        },
      ]),
    ).toEqual([
      {
        message: "invalid",
        path: "update.channel",
      },
    ]);

    expect(
      normalizeConfigIssue({
        allowedValues: ["stable"],
        allowedValuesHiddenCount: 2,
        message: "invalid",
        path: "update.channel",
      }),
    ).toEqual({
      allowedValues: ["stable"],
      allowedValuesHiddenCount: 2,
      message: "invalid",
      path: "update.channel",
    });
  });
});
