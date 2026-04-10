import { describe, expect, it } from "vitest";
import { resolveReactionLevel } from "./reaction-level.js";

describe("resolveReactionLevel", () => {
  it.each([
    {
      expected: {
        ackEnabled: false,
        agentReactionGuidance: "minimal",
        agentReactionsEnabled: true,
        level: "minimal",
      },
      input: {
        defaultLevel: "minimal" as const,
        invalidFallback: "ack" as const,
        value: undefined,
      },
      name: "defaults when value is missing",
    },
    {
      expected: { ackEnabled: true, agentReactionsEnabled: false, level: "ack" },
      input: { defaultLevel: "minimal" as const, invalidFallback: "ack" as const, value: "ack" },
      name: "supports ack",
    },
    {
      expected: {
        ackEnabled: false,
        agentReactionGuidance: "extensive",
        agentReactionsEnabled: true,
        level: "extensive",
      },
      input: {
        defaultLevel: "minimal" as const,
        invalidFallback: "ack" as const,
        value: "extensive",
      },
      name: "supports extensive",
    },
    {
      expected: { ackEnabled: true, agentReactionsEnabled: false, level: "ack" },
      input: { defaultLevel: "minimal" as const, invalidFallback: "ack" as const, value: "bogus" },
      name: "uses invalid fallback ack",
    },
    {
      expected: {
        ackEnabled: false,
        agentReactionGuidance: "minimal",
        agentReactionsEnabled: true,
        level: "minimal",
      },
      input: {
        defaultLevel: "minimal" as const,
        invalidFallback: "minimal" as const,
        value: "bogus",
      },
      name: "uses invalid fallback minimal",
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(resolveReactionLevel(input)).toEqual(expected);
  });
});
