import { describe, expect, it } from "vitest";
import { resolveReplyRoutingDecision } from "./routing-policy.js";

function isRoutableChannel(channel: string | undefined) {
  return Boolean(
    channel &&
    ["telegram", "slack", "discord", "signal", "imessage", "whatsapp", "feishu"].includes(channel),
  );
}

describe("resolveReplyRoutingDecision", () => {
  it("routes replies to the originating channel when the current provider differs", () => {
    expect(
      resolveReplyRoutingDecision({
        isRoutableChannel,
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        provider: "slack",
        surface: "slack",
      }),
    ).toMatchObject({
      currentSurface: "slack",
      originatingChannel: "telegram",
      shouldRouteToOriginating: true,
      shouldSuppressTyping: true,
    });
  });

  it("does not route external replies from internal webchat without explicit delivery", () => {
    expect(
      resolveReplyRoutingDecision({
        explicitDeliverRoute: false,
        isRoutableChannel,
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        provider: "webchat",
        surface: "webchat",
      }),
    ).toMatchObject({
      currentSurface: "webchat",
      isInternalWebchatTurn: true,
      shouldRouteToOriginating: false,
    });
  });

  it("suppresses direct user delivery for parent-owned background ACP children", () => {
    expect(
      resolveReplyRoutingDecision({
        isRoutableChannel,
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        provider: "discord",
        suppressDirectUserDelivery: true,
        surface: "discord",
      }),
    ).toMatchObject({
      currentSurface: "discord",
      shouldRouteToOriginating: false,
      shouldSuppressTyping: true,
    });
  });
});
