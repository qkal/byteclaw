import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import {
  formatOutboundPayloadLog,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
  normalizeReplyPayloadsForDelivery,
} from "./payloads.js";

describe("normalizeReplyPayloadsForDelivery", () => {
  it("parses directives, merges media, and preserves reply metadata", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        {
          mediaUrl: " https://x.test/a.png ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
          replyToTag: false,
          text: "[[reply_to: 123]] Hello [[audio_as_voice]]\nMEDIA:https://x.test/a.png",
        },
      ]),
    ).toEqual([
      {
        audioAsVoice: true,
        mediaUrl: undefined,
        mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        replyToCurrent: false,
        replyToId: "123",
        replyToTag: true,
        text: "Hello",
      },
    ]);
  });

  it("drops silent payloads without media and suppresses reasoning payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY" },
        { isReasoning: true, text: "Reasoning:\n_step_" },
        { text: "final answer" },
      ]),
    ).toEqual([
      {
        audioAsVoice: false,
        mediaUrl: undefined,
        mediaUrls: undefined,
        replyToCurrent: false,
        replyToId: undefined,
        replyToTag: false,
        text: "final answer",
      },
    ]);
  });

  it("drops JSON NO_REPLY action payloads without media", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: '{"action":"NO_REPLY"}' },
        { text: '{\n  "action": "NO_REPLY"\n}' },
      ]),
    ).toEqual([]);
  });

  it("keeps JSON NO_REPLY objects that include extra fields", () => {
    expect(
      normalizeReplyPayloadsForDelivery([{ text: '{"action":"NO_REPLY","note":"example"}' }]),
    ).toEqual([
      {
        audioAsVoice: false,
        mediaUrl: undefined,
        mediaUrls: undefined,
        replyToCurrent: false,
        replyToId: undefined,
        replyToTag: false,
        text: '{"action":"NO_REPLY","note":"example"}',
      },
    ]);
  });

  it("keeps renderable channel-data payloads and reply-to-current markers", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        {
          channelData: { line: { flexMessage: { altText: "Card", contents: {} } } },
          text: "[[reply_to_current]]",
        },
      ]),
    ).toEqual([
      {
        audioAsVoice: false,
        channelData: { line: { flexMessage: { altText: "Card", contents: {} } } },
        mediaUrl: undefined,
        mediaUrls: undefined,
        replyToCurrent: true,
        replyToTag: true,
        text: "",
      },
    ]);
  });
});

describe("normalizeOutboundPayloadsForJson", () => {
  function cloneReplyPayloads(
    input: Parameters<typeof normalizeOutboundPayloadsForJson>[0],
  ): ReplyPayload[] {
    return input.map((payload) =>
      "mediaUrls" in payload
        ? ({
            ...payload,
            mediaUrls: payload.mediaUrls ? [...payload.mediaUrls] : undefined,
          } as ReplyPayload)
        : ({ ...payload } as ReplyPayload),
    );
  }

  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof normalizeOutboundPayloadsForJson>[0];
      expected: ReturnType<typeof normalizeOutboundPayloadsForJson>;
    }>([
      {
        expected: [
          {
            audioAsVoice: undefined,
            channelData: undefined,
            mediaUrl: null,
            mediaUrls: undefined,
            text: "hi",
          },
          {
            audioAsVoice: true,
            channelData: undefined,
            mediaUrl: "https://x.test/a.jpg",
            mediaUrls: ["https://x.test/a.jpg"],
            text: "photo",
          },
          {
            audioAsVoice: undefined,
            channelData: undefined,
            mediaUrl: null,
            mediaUrls: ["https://x.test/1.png"],
            text: "multi",
          },
        ],
        input: [
          { text: "hi" },
          { audioAsVoice: true, mediaUrl: "https://x.test/a.jpg", text: "photo" },
          { mediaUrls: ["https://x.test/1.png"], text: "multi" },
        ],
        name: "text + media variants",
      },
      {
        expected: [
          {
            audioAsVoice: undefined,
            channelData: undefined,
            mediaUrl: null,
            mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
            text: "",
          },
        ],
        input: [
          {
            text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
          },
        ],
        name: "MEDIA directive extraction",
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(normalizeOutboundPayloadsForJson(cloneReplyPayloads(input))).toEqual(expected);
  });

  it("suppresses reasoning payloads", () => {
    expect(
      normalizeOutboundPayloadsForJson([
        { isReasoning: true, text: "Reasoning:\n_step_" },
        { text: "final answer" },
      ]),
    ).toEqual([
      { audioAsVoice: undefined, mediaUrl: null, mediaUrls: undefined, text: "final answer" },
    ]);
  });
});

describe("normalizeOutboundPayloads", () => {
  it("keeps channelData-only payloads", () => {
    const channelData = { line: { flexMessage: { altText: "Card", contents: {} } } };
    expect(normalizeOutboundPayloads([{ channelData }])).toEqual([
      { channelData, mediaUrls: [], text: "" },
    ]);
  });

  it("suppresses reasoning payloads", () => {
    expect(
      normalizeOutboundPayloads([
        { isReasoning: true, text: "Reasoning:\n_step_" },
        { text: "final answer" },
      ]),
    ).toEqual([{ mediaUrls: [], text: "final answer" }]);
  });

  it("formats BTW replies prominently for external delivery", () => {
    expect(
      normalizeOutboundPayloads([
        {
          btw: { question: "what is 17 * 19?" },
          text: "323",
        },
      ]),
    ).toEqual([{ mediaUrls: [], text: "BTW\nQuestion: what is 17 * 19?\n\n323" }]);
  });
});

describe("formatOutboundPayloadLog", () => {
  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof formatOutboundPayloadLog>[0];
      expected: string;
    }>([
      {
        expected: "hello\nMEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
        input: {
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
          text: "hello  ",
        },
        name: "text with media lines",
      },
      {
        expected: "MEDIA:https://x.test/a.png",
        input: {
          mediaUrls: ["https://x.test/a.png"],
          text: "",
        },
        name: "media only",
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(
      formatOutboundPayloadLog({
        ...input,
        mediaUrls: [...input.mediaUrls],
      }),
    ).toBe(expected);
  });
});
