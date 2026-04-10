import { describe, expect, it } from "vitest";
import {
  resolveExternalBestEffortDeliveryTarget,
  shouldDowngradeDeliveryToSessionOnly,
} from "./best-effort-delivery.js";

describe("best-effort delivery helpers", () => {
  it("resolves external delivery targets only for deliverable channels with to", () => {
    expect(
      resolveExternalBestEffortDeliveryTarget({
        accountId: "default",
        channel: "discord",
        threadId: "thread-1",
        to: "channel:123",
      }),
    ).toEqual({
      accountId: "default",
      channel: "discord",
      deliver: true,
      threadId: "thread-1",
      to: "channel:123",
    });
  });

  it("keeps webchat/internal targets session-only", () => {
    expect(
      resolveExternalBestEffortDeliveryTarget({
        channel: "webchat",
        to: "chat:123",
      }),
    ).toEqual({
      accountId: undefined,
      channel: undefined,
      deliver: false,
      threadId: undefined,
      to: undefined,
    });
  });

  it("returns session-only when to is missing", () => {
    expect(
      resolveExternalBestEffortDeliveryTarget({
        channel: "telegram",
      }),
    ).toEqual({
      accountId: undefined,
      channel: undefined,
      deliver: false,
      threadId: undefined,
      to: undefined,
    });
  });

  it("downgrades to session-only only for best-effort internal delivery requests", () => {
    expect(
      shouldDowngradeDeliveryToSessionOnly({
        bestEffortDeliver: true,
        resolvedChannel: "webchat",
        wantsDelivery: true,
      }),
    ).toBe(true);

    expect(
      shouldDowngradeDeliveryToSessionOnly({
        bestEffortDeliver: false,
        resolvedChannel: "webchat",
        wantsDelivery: true,
      }),
    ).toBe(false);

    expect(
      shouldDowngradeDeliveryToSessionOnly({
        bestEffortDeliver: true,
        resolvedChannel: "discord",
        wantsDelivery: true,
      }),
    ).toBe(false);
  });
});
