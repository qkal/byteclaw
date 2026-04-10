import { describe, expect, it } from "vitest";
import { concatOptionalTextSegments, joinPresentTextSegments } from "./join-segments.js";

function expectTextSegmentsCase<T>(actual: T, expected: T) {
  expect(actual).toBe(expected);
}

function expectJoinedTextSegmentsCase<T>(params: { run: () => T; expected: T }) {
  expectTextSegmentsCase(params.run(), params.expected);
}

describe("concatOptionalTextSegments", () => {
  it.each([
    { expected: "A\n\nB", params: { left: "A", right: "B" } },
    { expected: "", params: { left: "A", right: "" } },
    { expected: "A", params: { left: "A" } },
    { expected: "B", params: { right: "B" } },
    { expected: "B", params: { left: "", right: "B" } },
    { expected: "", params: { left: "" } },
    { expected: "A | B", params: { left: "A", right: "B", separator: " | " } },
  ] as const)("concatenates optional segments %#", ({ params, expected }) => {
    expectJoinedTextSegmentsCase({
      expected,
      run: () => concatOptionalTextSegments(params),
    });
  });
});

describe("joinPresentTextSegments", () => {
  it.each([
    { expected: "A\n\nB", options: undefined, segments: ["A", undefined, "B"] },
    { expected: undefined, options: undefined, segments: ["", undefined, null] },
    { expected: "A\n\nB", options: { trim: true }, segments: ["  A  ", "  B  "] },
    {
      expected: "A |     | B",
      options: { separator: " | " },
      segments: ["A", "   ", "B"],
    },
    {
      expected: "A | B",
      options: { separator: " | ", trim: true },
      segments: ["A", "   ", "B"],
    },
    { expected: "A|  B  ", options: { separator: "|" }, segments: ["A", "  B  "] },
  ] as const)("joins present segments %#", ({ segments, options, expected }) => {
    expectJoinedTextSegmentsCase({
      expected,
      run: () => joinPresentTextSegments(segments, options),
    });
  });
});
