import { describe, expect, it } from "vitest";
import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./session-contract.js";

describe("whatsapp legacy session contract", () => {
  it("canonicalizes legacy WhatsApp group keys to channel-qualified agent keys", () => {
    expect(canonicalizeLegacySessionKey({ agentId: "main", key: "group:123@g.us" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ agentId: "main", key: "123@g.us" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ agentId: "main", key: "whatsapp:123@g.us" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
  });

  it("does not claim generic non-WhatsApp group keys", () => {
    expect(isLegacyGroupSessionKey("group:abc")).toBe(false);
    expect(canonicalizeLegacySessionKey({ agentId: "main", key: "group:abc" })).toBeNull();
  });
});
