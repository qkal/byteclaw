import { describe, expect, it } from "vitest";
import { resolveConversationIdFromTargets } from "./conversation-id.js";

describe("resolveConversationIdFromTargets", () => {
  it.each([
    {
      expected: "123456789",
      name: "prefers explicit thread id strings",
      params: { targets: ["channel:987654321"], threadId: "123456789" },
    },
    {
      expected: "123456789",
      name: "normalizes numeric thread ids",
      params: { targets: ["channel:987654321"], threadId: 123_456_789 },
    },
    {
      expected: "987654321",
      name: "falls back when the thread id is blank",
      params: { targets: ["channel:987654321"], threadId: "   " },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveConversationIdFromTargets(params)).toBe(expected);
  });

  it.each([
    {
      expected: "987654321",
      name: "extracts channel ids from channel targets",
      targets: ["channel:987654321"],
    },
    {
      expected: "987654321",
      name: "trims channel target ids",
      targets: ["channel: 987654321 "],
    },
    {
      expected: "!room:example.org",
      name: "extracts room ids from Matrix room targets",
      targets: ["room:!room:example.org"],
    },
    {
      expected: "19:abc@thread.tacv2",
      name: "extracts ids from explicit conversation targets",
      targets: ["conversation:19:abc@thread.tacv2"],
    },
    {
      expected: "1471383327500481391",
      name: "extracts ids from explicit group targets",
      targets: ["group:1471383327500481391"],
    },
    {
      expected: "alice",
      name: "extracts ids from explicit dm targets",
      targets: ["dm:alice"],
    },
    {
      expected: "1475250310120214812",
      name: "extracts ids from Discord channel mentions",
      targets: ["<#1475250310120214812>"],
    },
    {
      expected: "1475250310120214812",
      name: "accepts raw numeric ids",
      targets: ["1475250310120214812"],
    },
    {
      expected: undefined,
      name: "returns undefined for non-channel targets",
      targets: ["user:alice", "general"],
    },
    {
      expected: undefined,
      name: "skips blank and malformed targets",
      targets: [undefined, null, "   ", "channel:  ", "<#not-a-number>"],
    },
  ])("$name", ({ targets, expected }) => {
    expect(resolveConversationIdFromTargets({ targets })).toBe(expected);
  });
});
