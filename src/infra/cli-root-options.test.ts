import { describe, expect, it } from "vitest";
import { consumeRootOptionToken, isValueToken } from "./cli-root-options.js";

function expectValueTokenCases(
  cases: readonly { value: string | undefined; expected: boolean }[],
): void {
  for (const { value, expected } of cases) {
    expect(isValueToken(value)).toBe(expected);
  }
}

describe("isValueToken", () => {
  it("classifies value-like and flag-like tokens", () => {
    expectValueTokenCases([
      { expected: true, value: "work" },
      { expected: true, value: "-1" },
      { expected: true, value: "-1.5" },
      { expected: true, value: "-0.5" },
      { expected: false, value: "--" },
      { expected: false, value: "--dev" },
      { expected: false, value: "-" },
      { expected: false, value: "" },
      { expected: false, value: undefined },
    ]);
  });
});

describe("consumeRootOptionToken", () => {
  it.each([
    { args: ["--dev"], expected: 1, index: 0 },
    { args: ["--profile=work"], expected: 1, index: 0 },
    { args: ["--log-level=debug"], expected: 1, index: 0 },
    { args: ["--container=openclaw-demo"], expected: 1, index: 0 },
    { args: ["--profile", "work"], expected: 2, index: 0 },
    { args: ["--container", "openclaw-demo"], expected: 2, index: 0 },
    { args: ["--profile", "-1"], expected: 2, index: 0 },
    { args: ["--log-level", "-1.5"], expected: 2, index: 0 },
    { args: ["--profile", "--no-color"], expected: 1, index: 0 },
    { args: ["--profile", "--"], expected: 1, index: 0 },
    { args: ["x", "--profile", "work"], expected: 2, index: 1 },
    { args: ["--log-level", ""], expected: 1, index: 0 },
    { args: ["--unknown"], expected: 0, index: 0 },
    { args: [], expected: 0, index: 0 },
  ])("consumes %j at %d", ({ args, index, expected }) => {
    expect(consumeRootOptionToken(args, index)).toBe(expected);
  });
});
