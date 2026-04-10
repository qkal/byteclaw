import { describe, expect, it, vi } from "vitest";
import { issuePairingChallenge } from "./pairing-challenge.js";

describe("issuePairingChallenge", () => {
  function createBaseChallengeParams() {
    return {
      channel: "telegram",
      senderId: "123",
      senderIdLine: "Your Telegram user id: 123",
    } as const;
  }

  async function issueChallengeAndCaptureReply(
    params: Omit<Parameters<typeof issuePairingChallenge>[0], "sendPairingReply">,
  ) {
    const sent: string[] = [];
    const result = await issuePairingChallenge({
      ...params,
      sendPairingReply: async (text) => {
        sent.push(text);
      },
    });
    return { result, sent };
  }

  function expectReplyTexts(sent: string[], expectedTexts: readonly string[]) {
    expect(sent).toEqual([...expectedTexts]);
  }

  function expectReplyContaining(sent: string[], expectedText: string) {
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(expectedText);
  }

  async function expectIssuedChallengeCase(params: {
    issueParams: Omit<Parameters<typeof issuePairingChallenge>[0], "sendPairingReply">;
    expectedResult: Awaited<ReturnType<typeof issuePairingChallenge>>;
    assertReply?: (sent: string[]) => void;
    sendPairingReply?: Parameters<typeof issuePairingChallenge>[0]["sendPairingReply"];
    assertResult?: () => void;
  }) {
    if (params.sendPairingReply) {
      const result = await issuePairingChallenge({
        ...params.issueParams,
        sendPairingReply: params.sendPairingReply,
      });
      expect(result).toEqual(params.expectedResult);
      params.assertResult?.();
      return;
    }

    const { result, sent } = await issueChallengeAndCaptureReply(params.issueParams);
    expect(result).toEqual(params.expectedResult);
    params.assertReply?.(sent);
    params.assertResult?.();
  }

  it.each([
    {
      assertReply: (sent: string[]) => {
        expectReplyContaining(sent, "ABCD");
      },
      expectedResult: { code: "ABCD", created: true },
      issueParams: {
        ...createBaseChallengeParams(),
        upsertPairingRequest: async () => ({ code: "ABCD", created: true }),
      },
      name: "creates and sends a pairing reply when request is newly created",
    },
    {
      assertReply: (sent: string[]) => {
        expectReplyTexts(sent, ["custom ZXCV"]);
      },
      expectedResult: { code: "ZXCV", created: true },
      issueParams: {
        buildReplyText: ({ code }: { code: string }) => `custom ${code}`,
        channel: "line",
        senderId: "u1",
        senderIdLine: "Your line id: u1",
        upsertPairingRequest: async () => ({ code: "ZXCV", created: true }),
      },
      name: "supports custom reply text builder",
    },
  ] as const)("$name", async ({ issueParams, expectedResult, assertReply }) => {
    await expectIssuedChallengeCase({
      assertReply,
      expectedResult,
      issueParams,
    });
  });

  it.each([
    {
      name: "does not send a reply when request already exists",
      setup: () => {
        const sendPairingReply = vi.fn(async () => {});
        return {
          assertResult: () => {
            expect(sendPairingReply).not.toHaveBeenCalled();
          },
          expectedResult: { created: false },
          issueParams: {
            ...createBaseChallengeParams(),
            upsertPairingRequest: async () => ({ code: "ABCD", created: false }),
          },
          sendPairingReply,
        };
      },
    },
    {
      name: "calls onCreated and forwards meta to upsert",
      setup: () => {
        const onCreated = vi.fn();
        const upsert = vi.fn(async () => ({ code: "1111", created: true }));
        return {
          assertResult: () => {
            expect(upsert).toHaveBeenCalledWith({ id: "42", meta: { name: "alice" } });
            expect(onCreated).toHaveBeenCalledWith({ code: "1111" });
          },
          expectedResult: { code: "1111", created: true },
          issueParams: {
            channel: "discord",
            meta: { name: "alice" },
            onCreated,
            senderId: "42",
            senderIdLine: "Your Discord user id: 42",
            upsertPairingRequest: upsert,
          },
          sendPairingReply: async () => {},
        };
      },
    },
    {
      name: "captures reply errors through onReplyError",
      setup: () => {
        const onReplyError = vi.fn();
        return {
          assertResult: () => {
            expect(onReplyError).toHaveBeenCalledTimes(1);
          },
          expectedResult: { code: "9999", created: true },
          issueParams: {
            channel: "signal",
            onReplyError,
            senderId: "+1555",
            senderIdLine: "Your Signal sender id: +1555",
            upsertPairingRequest: async () => ({ code: "9999", created: true }),
          },
          sendPairingReply: async () => {
            throw new Error("send failed");
          },
        };
      },
    },
  ] as const)("$name", async ({ setup }) => {
    await expectIssuedChallengeCase(setup());
  });
});
