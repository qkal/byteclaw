import { describe, expect, it } from "vitest";
import {
  buildDeliveryFromLegacyPayload,
  buildDeliveryPatchFromLegacyPayload,
  hasLegacyDeliveryHints,
  mergeLegacyDeliveryInto,
  normalizeLegacyDeliveryInput,
} from "./doctor-cron-legacy-delivery.js";

describe("legacy delivery threadId support", () => {
  it("treats threadId as a legacy delivery hint", () => {
    expect(hasLegacyDeliveryHints({ threadId: "42" })).toBe(true);
    expect(hasLegacyDeliveryHints({ threadId: 42 })).toBe(true);
  });

  it("hydrates threadId into new delivery payloads", () => {
    expect(
      buildDeliveryFromLegacyPayload({
        channel: "telegram",
        threadId: 42,
        to: "-100123:topic:42",
      }),
    ).toEqual({
      channel: "telegram",
      mode: "announce",
      threadId: "42",
      to: "-100123:topic:42",
    });
  });

  it("patches and merges threadId into existing deliveries", () => {
    expect(buildDeliveryPatchFromLegacyPayload({ threadId: "77" })).toEqual({
      mode: "announce",
      threadId: "77",
    });

    expect(
      mergeLegacyDeliveryInto(
        { channel: "telegram", mode: "announce", threadId: "1", to: "-100123" },
        { threadId: 77 },
      ),
    ).toEqual({
      delivery: { channel: "telegram", mode: "announce", threadId: "77", to: "-100123" },
      mutated: true,
    });
  });

  it("strips threadId from legacy payloads after normalization", () => {
    const payload: Record<string, unknown> = {
      channel: "telegram",
      threadId: 42,
      to: "-100123:topic:42",
    };

    expect(normalizeLegacyDeliveryInput({ payload })).toEqual({
      delivery: {
        channel: "telegram",
        mode: "announce",
        threadId: "42",
        to: "-100123:topic:42",
      },
      mutated: true,
    });
    expect(payload.threadId).toBeUndefined();
  });
});
