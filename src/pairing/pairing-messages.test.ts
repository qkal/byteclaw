import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectPairingReplyText } from "../../test/helpers/pairing-reply.js";
import { captureEnv } from "../test-utils/env.js";
import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_CONTAINER_HINT", "OPENCLAW_PROFILE"]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    process.env.OPENCLAW_PROFILE = "isolated";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  const pairingReplyCases = [
    {
      channel: "telegram",
      code: "QRS678",
      idLine: "Your Telegram user id: 42",
    },
    {
      channel: "discord",
      code: "ABC123",
      idLine: "Your Discord user id: 1",
    },
    {
      channel: "slack",
      code: "DEF456",
      idLine: "Your Slack user id: U1",
    },
    {
      channel: "signal",
      code: "GHI789",
      idLine: "Your Signal number: +15550001111",
    },
    {
      channel: "imessage",
      code: "JKL012",
      idLine: "Your iMessage sender id: +15550002222",
    },
    {
      channel: "whatsapp",
      code: "MNO345",
      idLine: "Your WhatsApp phone number: +15550003333",
    },
  ] as const;

  function expectPairingApproveCommand(text: string, testCase: (typeof pairingReplyCases)[number]) {
    const commandRe = new RegExp(
      `(?:openclaw|openclaw) --profile isolated pairing approve ${testCase.channel} ${testCase.code}`,
    );
    expect(text).toMatch(commandRe);
  }

  function expectProfileAwarePairingReply(testCase: (typeof pairingReplyCases)[number]) {
    const text = buildPairingReply(testCase);
    expectPairingReplyText(text, testCase);
    expectPairingApproveCommand(text, testCase);
  }

  it.each(pairingReplyCases)("formats pairing reply for $channel", (testCase) => {
    expectProfileAwarePairingReply(testCase);
  });
});
