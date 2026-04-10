import { describe, expect, it } from "vitest";
import {
  formatAllowFromLowercase,
  formatNormalizedAllowFromEntries,
  isAllowedParsedChatSender,
  isNormalizedSenderAllowed,
  mapAllowlistResolutionInputs,
} from "./allow-from.js";

function parseAllowTarget(
  entry: string,
):
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string } {
  const trimmed = entry.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("chat_id:")) {
    return { chatId: Number.parseInt(trimmed.slice("chat_id:".length), 10), kind: "chat_id" };
  }
  if (lower.startsWith("chat_guid:")) {
    return { chatGuid: trimmed.slice("chat_guid:".length), kind: "chat_guid" };
  }
  if (lower.startsWith("chat_identifier:")) {
    return {
      chatIdentifier: trimmed.slice("chat_identifier:".length),
      kind: "chat_identifier",
    };
  }
  return { handle: lower, kind: "handle" };
}

describe("isAllowedParsedChatSender", () => {
  it.each([
    {
      expected: false,
      input: {
        allowFrom: [],
        normalizeSender: (sender: string) => sender,
        parseAllowTarget,
        sender: "+15551234567",
      },
      name: "denies when allowFrom is empty",
    },
    {
      expected: true,
      input: {
        allowFrom: ["*"],
        normalizeSender: (sender: string) => sender.toLowerCase(),
        parseAllowTarget,
        sender: "user@example.com",
      },
      name: "allows wildcard entries",
    },
    {
      expected: true,
      input: {
        allowFrom: ["User@Example.com"],
        normalizeSender: (sender: string) => sender.toLowerCase(),
        parseAllowTarget,
        sender: "user@example.com",
      },
      name: "matches normalized handles",
    },
    {
      expected: true,
      input: {
        allowFrom: ["chat_id:42"],
        chatId: 42,
        normalizeSender: (sender: string) => sender,
        parseAllowTarget,
        sender: "+15551234567",
      },
      name: "matches chat IDs when provided",
    },
  ])("$name", ({ input, expected }) => {
    expect(isAllowedParsedChatSender(input)).toBe(expected);
  });
});

describe("isNormalizedSenderAllowed", () => {
  it.each([
    {
      expected: true,
      input: {
        allowFrom: ["*"],
        senderId: "attacker",
      },
      name: "allows wildcard",
    },
    {
      expected: true,
      input: {
        allowFrom: ["ZALO:12345", "zl:777"],
        senderId: "12345",
        stripPrefixRe: /^(zalo|zl):/i,
      },
      name: "normalizes case and strips prefixes",
    },
    {
      expected: false,
      input: {
        allowFrom: ["zl:12345"],
        senderId: "999",
        stripPrefixRe: /^(zalo|zl):/i,
      },
      name: "rejects when sender is missing",
    },
  ])("$name", ({ input, expected }) => {
    expect(isNormalizedSenderAllowed(input)).toBe(expected);
  });
});

describe("formatAllowFromLowercase", () => {
  it("trims, strips prefixes, and lowercases entries", () => {
    expect(
      formatAllowFromLowercase({
        allowFrom: [" Telegram:UserA ", "tg:UserB", "  "],
        stripPrefixRe: /^(telegram|tg):/i,
      }),
    ).toEqual(["usera", "userb"]);
  });
});

describe("formatNormalizedAllowFromEntries", () => {
  it.each([
    {
      expected: ["alice", "bob"],
      input: {
        allowFrom: ["  @Alice ", "", " @Bob "],
        normalizeEntry: (entry: string) => entry.replace(/^@/, "").toLowerCase(),
      },
      name: "applies custom normalization after trimming",
    },
    {
      expected: ["valid"],
      input: {
        allowFrom: ["@", "valid"],
        normalizeEntry: (entry: string) => entry.replace(/^@$/, ""),
      },
      name: "filters empty normalized entries",
    },
  ])("$name", ({ input, expected }) => {
    expect(formatNormalizedAllowFromEntries(input)).toEqual(expected);
  });
});

describe("mapAllowlistResolutionInputs", () => {
  it("maps inputs sequentially and preserves order", async () => {
    const visited: string[] = [];
    const result = await mapAllowlistResolutionInputs({
      inputs: ["one", "two", "three"],
      mapInput: async (input) => {
        visited.push(input);
        return input.toUpperCase();
      },
    });

    expect(visited).toEqual(["one", "two", "three"]);
    expect(result).toEqual(["ONE", "TWO", "THREE"]);
  });
});
