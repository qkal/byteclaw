import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

const baseConfig = {} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/image.png", text: "HEARTBEAT_OK" }],
      }),
    ).toEqual([{ mediaUrl: "/tmp/image.png", text: "" }]);
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toEqual([]);
  });

  it("drops media payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        sentMediaUrls: ["/tmp/img.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("suppresses replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        messageProvider: "slack",
        originatingTo: "channel:C1",
        payloads: [{ text: "hello world!" }],
        sentTargets: [{ provider: "slack", to: "channel:C1", tool: "slack" }],
      }),
    ).toEqual([]);
  });

  it("suppresses replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        payloads: [{ text: "hello world!" }],
        sentTargets: [{ provider: "telegram", to: "268300329", tool: "telegram" }],
      }),
    ).toEqual([]);
  });

  it("does not suppress replies when account differs", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        messageProvider: "heartbeat",
        originatingAccountId: "personal",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        payloads: [{ text: "hello world!" }],
        sentTargets: [
          { accountId: "work", provider: "telegram", to: "268300329", tool: "telegram" },
        ],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
