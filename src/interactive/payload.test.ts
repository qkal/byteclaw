import { describe, expect, it } from "vitest";
import {
  hasReplyChannelData,
  hasReplyContent,
  hasReplyPayloadContent,
  normalizeInteractiveReply,
  resolveInteractiveTextFallback,
} from "./payload.js";

describe("hasReplyChannelData", () => {
  it.each([
    { expected: false, value: undefined },
    { expected: false, value: {} },
    { expected: false, value: [] },
    { expected: true, value: { slack: { blocks: [] } } },
  ] as const)("accepts non-empty objects only: %j", ({ value, expected }) => {
    expect(hasReplyChannelData(value)).toBe(expected);
  });
});

describe("hasReplyContent", () => {
  it("treats whitespace-only text and empty structured payloads as empty", () => {
    expect(
      hasReplyContent({
        hasChannelData: false,
        interactive: { blocks: [] },
        mediaUrls: ["", "   "],
        text: "   ",
      }),
    ).toBe(false);
  });

  it.each([
    {
      input: {
        interactive: {
          blocks: [{ buttons: [{ label: "Retry", value: "retry" }], type: "buttons" }],
        },
      },
      name: "shared interactive blocks",
    },
    {
      input: {
        extraContent: true,
        text: "   ",
      },
      name: "explicit extra content",
    },
  ] as const)("accepts $name", ({ input }) => {
    expect(hasReplyContent(input)).toBe(true);
  });
});

describe("hasReplyPayloadContent", () => {
  it("trims text and falls back to channel data by default", () => {
    expect(
      hasReplyPayloadContent({
        channelData: { slack: { blocks: [] } },
        text: "   ",
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "explicit channel-data overrides",
      options: {
        hasChannelData: true,
      },
      payload: {
        channelData: {},
        text: "   ",
      },
    },
    {
      name: "extra content",
      options: {
        extraContent: true,
      },
      payload: {
        text: "   ",
      },
    },
  ] as const)("accepts $name", ({ payload, options }) => {
    expect(hasReplyPayloadContent(payload, options)).toBe(true);
  });
});

describe("interactive payload helpers", () => {
  it("normalizes interactive replies and resolves text fallbacks", () => {
    const interactive = normalizeInteractiveReply({
      blocks: [
        { text: "First", type: "text" },
        { buttons: [{ label: "Retry", value: "retry" }], type: "buttons" },
        { text: "Second", type: "text" },
      ],
    });

    expect(interactive).toEqual({
      blocks: [
        { text: "First", type: "text" },
        { buttons: [{ label: "Retry", value: "retry" }], type: "buttons" },
        { text: "Second", type: "text" },
      ],
    });
    expect(resolveInteractiveTextFallback({ interactive })).toBe("First\n\nSecond");
  });
});
