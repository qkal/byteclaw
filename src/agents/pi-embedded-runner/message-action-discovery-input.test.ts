import { describe, expect, it } from "vitest";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";

describe("buildEmbeddedMessageActionDiscoveryInput", () => {
  it("maps sender and routing scope into message-action discovery context", () => {
    expect(
      buildEmbeddedMessageActionDiscoveryInput({
        accountId: "acct-1",
        agentId: "main",
        channel: "telegram",
        currentChannelId: "chat-1",
        currentMessageId: "msg-42",
        currentThreadTs: "thread-9",
        senderId: "user-123",
        sessionId: "session-1",
        sessionKey: "agent:main:thread:1",
      }),
    ).toEqual({
      accountId: "acct-1",
      agentId: "main",
      cfg: undefined,
      channel: "telegram",
      currentChannelId: "chat-1",
      currentMessageId: "msg-42",
      currentThreadTs: "thread-9",
      requesterSenderId: "user-123",
      sessionId: "session-1",
      sessionKey: "agent:main:thread:1",
    });
  });

  it("normalizes nullable routing fields to undefined", () => {
    expect(
      buildEmbeddedMessageActionDiscoveryInput({
        accountId: null,
        agentId: null,
        channel: "slack",
        currentChannelId: null,
        currentMessageId: null,
        currentThreadTs: null,
        senderId: null,
        sessionId: null,
        sessionKey: null,
      }),
    ).toEqual({
      accountId: undefined,
      agentId: undefined,
      cfg: undefined,
      channel: "slack",
      currentChannelId: undefined,
      currentMessageId: undefined,
      currentThreadTs: undefined,
      requesterSenderId: undefined,
      sessionId: undefined,
      sessionKey: undefined,
    });
  });
});
