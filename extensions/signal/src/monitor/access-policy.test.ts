import { describe, expect, it, vi } from "vitest";
import { handleSignalDirectMessageAccess } from "./access-policy.js";

describe("handleSignalDirectMessageAccess", () => {
  it("returns true for already-allowed direct messages", async () => {
    await expect(
      handleSignalDirectMessageAccess({
        accountId: "default",
        dmAccessDecision: "allow",
        dmPolicy: "open",
        log: () => {},
        sendPairingReply: async () => {},
        senderDisplay: "Alice",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
      }),
    ).resolves.toBe(true);
  });

  it("issues a pairing challenge for pairing-gated senders", async () => {
    const replies: string[] = [];
    const sendPairingReply = vi.fn(async (text: string) => {
      replies.push(text);
    });

    await expect(
      handleSignalDirectMessageAccess({
        accountId: "default",
        dmAccessDecision: "pairing",
        dmPolicy: "pairing",
        log: () => {},
        sendPairingReply,
        senderDisplay: "Alice",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderName: "Alice",
      }),
    ).resolves.toBe(false);

    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("Pairing code:");
  });
});
