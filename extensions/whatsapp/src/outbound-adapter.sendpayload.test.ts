import { describe, expect, it, vi } from "vitest";
import { whatsappOutbound } from "./outbound-adapter.js";

describe("whatsappOutbound sendPayload", () => {
  it("trims leading whitespace for direct text sends", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendText!({
      cfg: {},
      deps: { sendWhatsApp },
      text: "\n \thello",
      to: "5511999999999@c.us",
    });

    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "hello", {
      accountId: undefined,
      cfg: {},
      gifPlayback: undefined,
      verbose: false,
    });
  });

  it("trims leading whitespace for direct media captions", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendMedia!({
      cfg: {},
      deps: { sendWhatsApp },
      mediaUrl: "/tmp/test.png",
      text: "\n \tcaption",
      to: "5511999999999@c.us",
    });

    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "caption", {
      accountId: undefined,
      cfg: {},
      gifPlayback: undefined,
      mediaLocalRoots: undefined,
      mediaUrl: "/tmp/test.png",
      verbose: false,
    });
  });

  it("trims leading whitespace for sendPayload text and caption delivery", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendPayload!({
      cfg: {},
      deps: { sendWhatsApp },
      payload: { text: "\n\nhello" },
      text: "",
      to: "5511999999999@c.us",
    });
    await whatsappOutbound.sendPayload!({
      cfg: {},
      deps: { sendWhatsApp },
      payload: { mediaUrl: "/tmp/test.png", text: "\n\ncaption" },
      text: "",
      to: "5511999999999@c.us",
    });

    expect(sendWhatsApp).toHaveBeenNthCalledWith(1, "5511999999999@c.us", "hello", {
      accountId: undefined,
      cfg: {},
      gifPlayback: undefined,
      verbose: false,
    });
    expect(sendWhatsApp).toHaveBeenNthCalledWith(2, "5511999999999@c.us", "caption", {
      accountId: undefined,
      cfg: {},
      gifPlayback: undefined,
      mediaLocalRoots: undefined,
      mediaUrl: "/tmp/test.png",
      verbose: false,
    });
  });

  it("skips whitespace-only text payloads", async () => {
    const sendWhatsApp = vi.fn();

    const result = await whatsappOutbound.sendPayload!({
      cfg: {},
      deps: { sendWhatsApp },
      payload: { text: "\n \t" },
      text: "",
      to: "5511999999999@c.us",
    });

    expect(result).toEqual({ channel: "whatsapp", messageId: "" });
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
});
