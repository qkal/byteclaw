import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "1555@s.whatsapp.net" })),
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../../src/globals.js", () => ({
  shouldLogVerbose: () => false,
}));

vi.mock("./send.js", () => ({
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

let whatsappOutbound: typeof import("./outbound-adapter.js").whatsappOutbound;

describe("whatsappOutbound sendPoll", () => {
  beforeAll(async () => {
    ({ whatsappOutbound } = await import("./outbound-adapter.js"));
  });

  beforeEach(() => {
    hoisted.sendPollWhatsApp.mockClear();
    hoisted.sendReactionWhatsApp.mockClear();
  });

  it("threads cfg through poll send options", async () => {
    const cfg = { marker: "resolved-cfg" } as OpenClawConfig;
    const poll = {
      maxSelections: 1,
      options: ["Pizza", "Sushi"],
      question: "Lunch?",
    };

    const result = await whatsappOutbound.sendPoll!({
      accountId: "work",
      cfg,
      poll,
      to: "+1555",
    });

    expect(hoisted.sendPollWhatsApp).toHaveBeenCalledWith("+1555", poll, {
      accountId: "work",
      cfg,
      verbose: false,
    });
    expect(result).toEqual({
      channel: "whatsapp",
      messageId: "poll-1",
      toJid: "1555@s.whatsapp.net",
    });
  });
});
