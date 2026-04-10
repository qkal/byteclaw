import { describe, expect, it } from "vitest";
import { normalizePollDurationHours, normalizePollInput } from "./polls.js";

describe("polls", () => {
  it("normalizes question/options and validates maxSelections", () => {
    expect(
      normalizePollInput({
        maxSelections: 2,
        options: [" Pizza ", " ", "Sushi"],
        question: "  Lunch? ",
      }),
    ).toEqual({
      durationHours: undefined,
      durationSeconds: undefined,
      maxSelections: 2,
      options: ["Pizza", "Sushi"],
      question: "Lunch?",
    });
  });

  it("enforces max option count when configured", () => {
    expect(() =>
      normalizePollInput({ options: ["A", "B", "C"], question: "Q" }, { maxOptions: 2 }),
    ).toThrow(/at most 2/);
  });

  it.each([
    { durationHours: undefined, expected: 24 },
    { durationHours: 999, expected: 48 },
    { durationHours: 1, expected: 1 },
  ])("clamps poll duration for $durationHours hours", ({ durationHours, expected }) => {
    expect(normalizePollDurationHours(durationHours, { defaultHours: 24, maxHours: 48 })).toBe(
      expected,
    );
  });

  it("rejects both durationSeconds and durationHours", () => {
    expect(() =>
      normalizePollInput({
        durationHours: 1,
        durationSeconds: 60,
        options: ["A", "B"],
        question: "Q",
      }),
    ).toThrow(/mutually exclusive/);
  });
});
