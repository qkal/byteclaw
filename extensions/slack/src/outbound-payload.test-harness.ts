import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { primeChannelOutboundSendMock } from "openclaw/plugin-sdk/testing";
import { type Mock, vi } from "vitest";
import { slackOutbound } from "./outbound-adapter.js";

type OutboundSendMock = Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;

interface SlackOutboundPayloadHarness {
  run: () => Promise<Record<string, unknown>>;
  sendMock: OutboundSendMock;
  to: string;
}

export function createSlackOutboundPayloadHarness(params: {
  payload: ReplyPayload;
  sendResults?: { messageId: string }[];
}): SlackOutboundPayloadHarness {
  const sendSlack: OutboundSendMock = vi.fn();
  primeChannelOutboundSendMock(
    sendSlack,
    { channelId: "C12345", messageId: "sl-1", ts: "1234.5678" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    deps: {
      sendSlack,
    },
    payload: params.payload,
    text: "",
    to: "C12345",
  };
  return {
    run: async () => await slackOutbound.sendPayload!(ctx),
    sendMock: sendSlack,
    to: ctx.to,
  };
}
