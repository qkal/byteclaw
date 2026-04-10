import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { buildOutboundResultEnvelope } from "./envelope.js";
import type { OutboundDeliveryJson } from "./format.js";

describe("buildOutboundResultEnvelope", () => {
  const delivery: OutboundDeliveryJson = {
    channel: "telegram",
    chatId: "c1",
    mediaUrl: null,
    messageId: "m1",
    to: "123",
    via: "direct",
  };
  const payloads = [{ mediaUrl: null, mediaUrls: undefined, text: "hi" }];

  it.each([
    {
      expected: delivery,
      input: { delivery },
    },
    {
      expected: {
        meta: { ok: true },
        payloads: [{ mediaUrl: null, mediaUrls: undefined, text: "hi" }],
      },
      input: {
        meta: { ok: true },
        payloads,
      },
    },
  ])("formats outbound envelope for %j", ({ input, expected }) => {
    const envelope = buildOutboundResultEnvelope(input);
    expect(envelope).toEqual(expected);
    if ("payloads" in input) {
      expect((envelope as { payloads: unknown[] }).payloads).not.toBe(input.payloads);
    }
  });

  it("normalizes reply payloads and keeps wrapped delivery when flattening is disabled", () => {
    const payloads: ReplyPayload[] = [{ text: "hello" }];

    expect(
      buildOutboundResultEnvelope({
        delivery,
        flattenDelivery: false,
        payloads,
      }),
    ).toEqual({
      delivery,
      payloads: [
        {
          channelData: undefined,
          mediaUrl: null,
          text: "hello",
        },
      ],
    });
  });
});
