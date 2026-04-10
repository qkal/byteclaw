import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

function createMessage(overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  return {
    accountId: "default",
    body: "hello",
    chatId: "15551234567@s.whatsapp.net",
    chatType: "direct",
    conversationId: "15551234567",
    from: "15551234567",
    id: "msg-1",
    reply: async () => {},
    sendComposing: async () => {},
    sendMedia: async () => {},
    to: "15559876543",
    ...overrides,
  };
}

function createConfig(
  reactionLevel: "off" | "ack" | "minimal" | "extensive",
  extras?: Partial<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>,
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        ackReaction: {
          direct: true,
          emoji: "👀",
          group: "mentions",
        },
        reactionLevel,
        ...extras,
      },
    },
  } as OpenClawConfig;
}

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["ack", "minimal", "extensive"] as const)(
    "sends ack reactions when reactionLevel is %s",
    (reactionLevel) => {
      maybeSendAckReaction({
        accountId: "default",
        agentId: "agent",
        cfg: createConfig(reactionLevel),
        conversationId: "15551234567",
        info: vi.fn(),
        msg: createMessage(),
        sessionKey: "whatsapp:default:15551234567",
        verbose: false,
        warn: vi.fn(),
      });

      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
        "15551234567@s.whatsapp.net",
        "msg-1",
        "👀",
        {
          accountId: "default",
          fromMe: false,
          participant: undefined,
          verbose: false,
        },
      );
    },
  );

  it("suppresses ack reactions when reactionLevel is off", () => {
    maybeSendAckReaction({
      accountId: "default",
      agentId: "agent",
      cfg: createConfig("off"),
      conversationId: "15551234567",
      info: vi.fn(),
      msg: createMessage(),
      sessionKey: "whatsapp:default:15551234567",
      verbose: false,
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("uses the active account reactionLevel override for ack gating", () => {
    maybeSendAckReaction({
      accountId: "work",
      agentId: "agent",
      cfg: createConfig("off", {
        accounts: {
          work: {
            reactionLevel: "ack",
          },
        },
      }),
      conversationId: "15551234567",
      info: vi.fn(),
      msg: createMessage({
        accountId: "work",
      }),
      sessionKey: "whatsapp:work:15551234567",
      verbose: false,
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "👀",
      {
        accountId: "work",
        fromMe: false,
        participant: undefined,
        verbose: false,
      },
    );
  });
});
