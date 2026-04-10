import { describe, expect, it } from "vitest";
import { buildTelegramInboundDebounceKey } from "./bot-handlers.debounce-key.js";

describe("buildTelegramInboundDebounceKey", () => {
  it("uses the resolved account id instead of literal default when provided", () => {
    expect(
      buildTelegramInboundDebounceKey({
        accountId: "work",
        conversationKey: "12345",
        debounceLane: "default",
        senderId: "67890",
      }),
    ).toBe("telegram:work:12345:67890:default");
  });

  it("falls back to literal default only when account id is actually absent", () => {
    expect(
      buildTelegramInboundDebounceKey({
        accountId: undefined,
        conversationKey: "12345",
        debounceLane: "forward",
        senderId: "67890",
      }),
    ).toBe("telegram:default:12345:67890:forward");
  });
});
