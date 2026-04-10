import { describe, expect, it, vi } from "vitest";
import { createWhatsAppOutboundBase } from "./outbound-base.js";
import { createWhatsAppPollFixture } from "./outbound-test-support.js";

describe("createWhatsAppOutboundBase", () => {
  it("exposes the provided chunker", () => {
    const outbound = createWhatsAppOutboundBase({
      chunker: (text, limit) => [text.slice(0, limit)],
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
      sendMessageWhatsApp: vi.fn(),
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
    });

    expect(outbound.chunker?.("alpha beta", 5)).toEqual(["alpha"]);
  });

  it("forwards mediaLocalRoots to sendMessageWhatsApp", async () => {
    const sendMessageWhatsApp = vi.fn(async () => ({
      messageId: "msg-1",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
      sendMessageWhatsApp,
      sendPollWhatsApp: vi.fn(),
      shouldLogVerbose: () => false,
    });
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await outbound.sendMedia!({
      accountId: "default",
      cfg: {} as never,
      deps: { sendWhatsApp: sendMessageWhatsApp },
      gifPlayback: false,
      mediaLocalRoots,
      mediaUrl: "/tmp/workspace/photo.png",
      text: "photo",
      to: "whatsapp:+15551234567",
    });

    expect(sendMessageWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "photo",
      expect.objectContaining({
        accountId: "default",
        gifPlayback: false,
        mediaLocalRoots,
        mediaUrl: "/tmp/workspace/photo.png",
        verbose: false,
      }),
    );
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "msg-1" });
  });

  it("threads cfg into sendPollWhatsApp call", async () => {
    const sendPollWhatsApp = vi.fn(async () => ({
      messageId: "wa-poll-1",
      toJid: "1555@s.whatsapp.net",
    }));
    const outbound = createWhatsAppOutboundBase({
      chunker: (text) => [text],
      resolveTarget: ({ to }) => ({ ok: true as const, to: to ?? "" }),
      sendMessageWhatsApp: vi.fn(),
      sendPollWhatsApp,
      shouldLogVerbose: () => false,
    });
    const { cfg, poll, to, accountId } = createWhatsAppPollFixture();

    const result = await outbound.sendPoll!({
      accountId,
      cfg,
      poll,
      to,
    });

    expect(sendPollWhatsApp).toHaveBeenCalledWith(to, poll, {
      accountId,
      cfg,
      verbose: false,
    });
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "wa-poll-1",
      toJid: "1555@s.whatsapp.net",
    });
  });
});
