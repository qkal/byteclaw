import { describe, expect, it } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

describe("normalizeMessageActionInput", () => {
  interface NormalizeMessageActionInputCase {
    input: Parameters<typeof normalizeMessageActionInput>[0];
    expectedFields?: Record<string, unknown>;
    absentFields?: string[];
  }

  it.each([
    {
      absentFields: ["channelId"],
      expectedFields: { target: "channel:C1", to: "channel:C1" },
      input: {
        action: "send",
        args: {
          channelId: "legacy-channel",
          target: "channel:C1",
          to: "legacy",
        },
      },
    },
    {
      absentFields: ["channelId"],
      expectedFields: { target: "1214056829", to: "1214056829" },
      input: {
        action: "send",
        args: {
          channelId: "",
          target: "1214056829",
          to: "   ",
        },
      },
    },
    {
      expectedFields: { target: "channel:C1", to: "channel:C1" },
      input: {
        action: "send",
        args: {
          to: "channel:C1",
        },
      },
    },
    {
      expectedFields: { target: "channel:C1", to: "channel:C1" },
      input: {
        action: "send",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
    },
    {
      expectedFields: { channel: "slack" },
      input: {
        action: "send",
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelId: "C1",
          currentChannelProvider: "slack",
        },
      },
    },
    {
      absentFields: ["target", "to"],
      input: {
        action: "broadcast",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
    },
    {
      absentFields: ["channel"],
      input: {
        action: "send",
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelProvider: "webchat",
        },
      },
    },
    {
      absentFields: ["target", "to"],
      expectedFields: { messageId: "msg_123" },
      input: {
        action: "edit",
        args: {
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
    },
    {
      absentFields: ["target", "to"],
      expectedFields: { messageId: "om_123" },
      input: {
        action: "pin",
        args: {
          channel: "feishu",
          messageId: "om_123",
        },
      },
    },
    {
      absentFields: ["target", "to"],
      expectedFields: { chatId: "oc_123" },
      input: {
        action: "list-pins",
        args: {
          channel: "feishu",
          chatId: "oc_123",
        },
      },
    },
    {
      expectedFields: { messageId: "123.456", target: "C12345678" },
      input: {
        action: "read",
        args: {
          channel: "slack",
          messageId: "123.456",
        },
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "slack",
        },
      },
    },
    {
      absentFields: ["to"],
      expectedFields: { channelId: "C123", target: "C123" },
      input: {
        action: "channel-info",
        args: {
          channelId: "C123",
        },
      },
    },
  ] satisfies NormalizeMessageActionInputCase[])(
    "normalizes message action input for %j",
    ({ input, expectedFields, absentFields }) => {
      const normalized = normalizeMessageActionInput(input);
      if (expectedFields) {
        for (const [field, value] of Object.entries(expectedFields)) {
          expect(normalized[field]).toBe(value);
        }
      }
      for (const field of absentFields ?? []) {
        expect(field in normalized).toBe(false);
      }
    },
  );

  it("throws when required target remains unresolved", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
      }),
    ).toThrow(/requires a target/);
  });
});
