import { describe, expect, it } from "vitest";
import { parseConfigCommand } from "./config-commands.js";
import { parseDebugCommand } from "./debug-commands.js";

describe("config/debug command parsing", () => {
  it("parses config/debug command actions and JSON payloads", () => {
    const cases: {
      parse: (input: string) => unknown;
      input: string;
      expected: unknown;
    }[] = [
      { expected: { action: "show" }, input: "/config", parse: parseConfigCommand },
      {
        expected: { action: "show", path: undefined },
        input: "/config show",
        parse: parseConfigCommand,
      },
      {
        expected: { action: "show", path: "foo.bar" },
        input: "/config show foo.bar",
        parse: parseConfigCommand,
      },
      {
        expected: { action: "show", path: "foo.bar" },
        input: "/config get foo.bar",
        parse: parseConfigCommand,
      },
      {
        expected: { action: "unset", path: "foo.bar" },
        input: "/config unset foo.bar",
        parse: parseConfigCommand,
      },
      {
        expected: { action: "set", path: "foo", value: { a: 1 } },
        input: '/config set foo={"a":1}',
        parse: parseConfigCommand,
      },
      { expected: { action: "show" }, input: "/debug", parse: parseDebugCommand },
      { expected: { action: "show" }, input: "/debug show", parse: parseDebugCommand },
      { expected: { action: "reset" }, input: "/debug reset", parse: parseDebugCommand },
      {
        expected: { action: "unset", path: "foo.bar" },
        input: "/debug unset foo.bar",
        parse: parseDebugCommand,
      },
      {
        expected: { action: "set", path: "foo", value: { a: 1 } },
        input: '/debug set foo={"a":1}',
        parse: parseDebugCommand,
      },
    ];

    for (const testCase of cases) {
      expect(testCase.parse(testCase.input)).toEqual(testCase.expected);
    }
  });
});
