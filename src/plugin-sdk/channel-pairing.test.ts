import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  createChannelPairingChallengeIssuer,
  createChannelPairingController,
} from "./channel-pairing.js";

function createReplyCollector() {
  const replies: string[] = [];
  return {
    replies,
    sendPairingReply: vi.fn(async (text: string) => {
      replies.push(text);
    }),
  };
}

describe("createChannelPairingController", () => {
  it("scopes store access and issues pairing challenges through the scoped store", async () => {
    const readAllowFromStore = vi.fn(async () => ["alice"]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "123456", created: true }));
    const { replies, sendPairingReply } = createReplyCollector();
    const runtime = {
      channel: {
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
        },
      },
    } as unknown as PluginRuntime;

    const pairing = createChannelPairingController({
      accountId: "Primary",
      channel: "googlechat",
      core: runtime,
    });

    await expect(pairing.readAllowFromStore()).resolves.toEqual(["alice"]);
    await pairing.issueChallenge({
      sendPairingReply,
      senderId: "user-1",
      senderIdLine: "Your id: user-1",
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      accountId: "primary",
      channel: "googlechat",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      accountId: "primary",
      channel: "googlechat",
      id: "user-1",
      meta: undefined,
    });
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("123456");
  });
});

describe("createChannelPairingChallengeIssuer", () => {
  it("binds a channel and scoped pairing store to challenge issuance", async () => {
    const upsertPairingRequest = vi.fn(async () => ({ code: "654321", created: true }));
    const { replies, sendPairingReply } = createReplyCollector();
    const issueChallenge = createChannelPairingChallengeIssuer({
      channel: "signal",
      upsertPairingRequest,
    });

    await issueChallenge({
      sendPairingReply,
      senderId: "user-2",
      senderIdLine: "Your id: user-2",
    });

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      id: "user-2",
      meta: undefined,
    });
    expect(replies[0]).toContain("654321");
  });
});
