import { describe, expect, it } from "vitest";
import { buildHistoryContextFromEntries } from "../auto-reply/reply/history.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { buildAgentMessageFromConversationEntries } from "./agent-prompt.js";

describe("gateway agent prompt", () => {
  it("returns empty for no entries", () => {
    expect(buildAgentMessageFromConversationEntries([])).toBe("");
  });

  it("returns current body when there is no history", () => {
    expect(
      buildAgentMessageFromConversationEntries([
        { entry: { body: "hi", sender: "User" }, role: "user" },
      ]),
    ).toBe("hi");
  });

  it("extracts text from content-array body when there is no history", () => {
    expect(
      buildAgentMessageFromConversationEntries([
        {
          entry: {
            body: [
              { text: "hi", type: "text" },
              { data: "base64-image", mimeType: "image/png", type: "image" },
              { text: "there", type: "text" },
            ] as unknown as string,
            sender: "User",
          },
          role: "user",
        },
      ]),
    ).toBe("hi there");
  });

  it("uses history context when there is history", () => {
    const entries = [
      { entry: { body: "prev", sender: "Assistant" }, role: "assistant" },
      { entry: { body: "next", sender: "User" }, role: "user" },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      currentMessage: "User: next",
      entries: entries.map((e) => e.entry),
      formatEntry: (e) => `${e.sender}: ${e.body}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });

  it("prefers last tool entry over assistant for current message", () => {
    const entries = [
      { entry: { body: "question", sender: "User" }, role: "user" },
      { entry: { body: "tool output", sender: "Tool:x" }, role: "tool" },
      { entry: { body: "assistant text", sender: "Assistant" }, role: "assistant" },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      currentMessage: "Tool:x: tool output",
      entries: [entries[0].entry, entries[1].entry],
      formatEntry: (e) => `${e.sender}: ${e.body}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });

  it("normalizes content-array bodies in history and current message", () => {
    const entries = [
      {
        entry: {
          body: [{ text: "prev", type: "text" }] as unknown as string,
          sender: "Assistant",
        },
        role: "assistant",
      },
      {
        entry: {
          body: [
            { text: "next", type: "text" },
            { text: "step", type: "text" },
          ] as unknown as string,
          sender: "User",
        },
        role: "user",
      },
    ] as const;

    const expected = buildHistoryContextFromEntries({
      currentMessage: "User: next step",
      entries: entries.map((e) => e.entry),
      formatEntry: (e) => `${e.sender}: ${extractTextFromChatContent(e.body) ?? ""}`,
    });

    expect(buildAgentMessageFromConversationEntries([...entries])).toBe(expected);
  });
});
