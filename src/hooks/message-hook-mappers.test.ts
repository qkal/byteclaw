import { beforeEach, describe, expect, it } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildCanonicalSentMessageHookContext,
  deriveInboundMessageHookContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageReceivedContext,
  toInternalMessageSentContext,
  toInternalMessageTranscribedContext,
  toPluginInboundClaimContext,
  toPluginInboundClaimEvent,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  toPluginMessageSentEvent,
} from "./message-hook-mappers.js";

function makeInboundCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    AccountId: "acc-1",
    Body: "body",
    BodyForAgent: "body-for-agent",
    BodyForCommands: "commands-body",
    From: "demo-chat:user:123",
    GroupChannel: "ops-room",
    GroupSpace: "guild-1",
    GroupSubject: "ops",
    MediaPath: "/tmp/audio.ogg",
    MediaType: "audio/ogg",
    MessageSid: "msg-1",
    MessageThreadId: 42,
    OriginatingChannel: "demo-chat",
    OriginatingTo: "demo-chat:chat:456",
    Provider: "demo-chat",
    RawBody: "raw-body",
    SenderE164: "+15551234567",
    SenderId: "sender-1",
    SenderName: "User One",
    SenderUsername: "userone",
    Surface: "demo-chat",
    Timestamp: 1_710_000_000,
    To: "demo-chat:chat:456",
    Transcript: "hello transcript",
    ...overrides,
  } as FinalizedMsgContext;
}

describe("message hook mappers", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({ id: "claim-chat", label: "Claim chat" }),
            messaging: {
              resolveInboundConversation: ({
                from,
                to,
                isGroup,
              }: {
                from?: string;
                to?: string;
                isGroup?: boolean;
              }) => {
                const normalizedTo = to?.replace(/^channel:/i, "").trim();
                const normalizedFrom = from?.replace(/^claim-chat:/i, "").trim();
                if (isGroup && normalizedTo) {
                  return { conversationId: `channel:${normalizedTo}` };
                }
                if (normalizedFrom) {
                  return { conversationId: `user:${normalizedFrom}` };
                }
                return null;
              },
            },
          },
          pluginId: "claim-chat",
          source: "test",
        },
      ]),
    );
  });

  it("derives canonical inbound context with body precedence and group metadata", () => {
    const canonical = deriveInboundMessageHookContext(makeInboundCtx());

    expect(canonical.content).toBe("commands-body");
    expect(canonical.channelId).toBe("demo-chat");
    expect(canonical.conversationId).toBe("demo-chat:chat:456");
    expect(canonical.messageId).toBe("msg-1");
    expect(canonical.isGroup).toBe(true);
    expect(canonical.groupId).toBe("demo-chat:chat:456");
    expect(canonical.guildId).toBe("guild-1");
  });

  it("supports explicit content/messageId overrides", () => {
    const canonical = deriveInboundMessageHookContext(makeInboundCtx(), {
      content: "override-content",
      messageId: "override-msg",
    });

    expect(canonical.content).toBe("override-content");
    expect(canonical.messageId).toBe("override-msg");
  });

  it("preserves multi-attachment arrays for inbound claim metadata", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        MediaPath: undefined,
        MediaPaths: ["/tmp/tree.jpg", "/tmp/ramp.jpg"],
        MediaType: undefined,
        MediaTypes: ["image/jpeg", "image/jpeg"],
      }),
    );

    expect(canonical.mediaPath).toBe("/tmp/tree.jpg");
    expect(canonical.mediaType).toBe("image/jpeg");
    expect(canonical.mediaPaths).toEqual(["/tmp/tree.jpg", "/tmp/ramp.jpg"]);
    expect(canonical.mediaTypes).toEqual(["image/jpeg", "image/jpeg"]);
    expect(toPluginInboundClaimEvent(canonical)).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          mediaPath: "/tmp/tree.jpg",
          mediaPaths: ["/tmp/tree.jpg", "/tmp/ramp.jpg"],
          mediaType: "image/jpeg",
          mediaTypes: ["image/jpeg", "image/jpeg"],
        }),
      }),
    );
  });

  it("maps canonical inbound context to plugin/internal received payloads", () => {
    const canonical = deriveInboundMessageHookContext(makeInboundCtx());

    expect(toPluginMessageContext(canonical)).toEqual({
      accountId: "acc-1",
      channelId: "demo-chat",
      conversationId: "demo-chat:chat:456",
    });
    expect(toPluginMessageReceivedEvent(canonical)).toEqual({
      content: "commands-body",
      from: "demo-chat:user:123",
      metadata: expect.objectContaining({
        messageId: "msg-1",
        senderName: "User One",
        threadId: 42,
      }),
      timestamp: 1_710_000_000,
    });
    expect(toInternalMessageReceivedContext(canonical)).toEqual({
      accountId: "acc-1",
      channelId: "demo-chat",
      content: "commands-body",
      conversationId: "demo-chat:chat:456",
      from: "demo-chat:user:123",
      messageId: "msg-1",
      metadata: expect.objectContaining({
        senderE164: "+15551234567",
        senderUsername: "userone",
      }),
      timestamp: 1_710_000_000,
    });
  });

  it("uses channel plugin claim resolvers for grouped conversations", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        GroupChannel: "general",
        GroupSubject: "guild",
        OriginatingChannel: "claim-chat",
        OriginatingTo: "channel:123456789012345678",
        Provider: "claim-chat",
        Surface: "claim-chat",
        To: "channel:123456789012345678",
      }),
    );

    expect(toPluginInboundClaimContext(canonical)).toEqual({
      accountId: "acc-1",
      channelId: "claim-chat",
      conversationId: "channel:123456789012345678",
      messageId: "msg-1",
      parentConversationId: undefined,
      senderId: "sender-1",
    });
  });

  it("uses channel plugin claim resolvers for direct-message conversations", () => {
    const canonical = deriveInboundMessageHookContext(
      makeInboundCtx({
        From: "claim-chat:1177378744822943744",
        GroupChannel: undefined,
        GroupSubject: undefined,
        OriginatingChannel: "claim-chat",
        OriginatingTo: "channel:1480574946919846079",
        Provider: "claim-chat",
        Surface: "claim-chat",
        To: "channel:1480574946919846079",
      }),
    );

    expect(toPluginInboundClaimContext(canonical)).toEqual({
      accountId: "acc-1",
      channelId: "claim-chat",
      conversationId: "user:1177378744822943744",
      messageId: "msg-1",
      parentConversationId: undefined,
      senderId: "sender-1",
    });
  });

  it("maps transcribed and preprocessed internal payloads", () => {
    const cfg = {} as OpenClawConfig;
    const canonical = deriveInboundMessageHookContext(makeInboundCtx({ Transcript: undefined }));

    const transcribed = toInternalMessageTranscribedContext(canonical, cfg);
    expect(transcribed.transcript).toBe("");
    expect(transcribed.cfg).toBe(cfg);

    const preprocessed = toInternalMessagePreprocessedContext(canonical, cfg);
    expect(preprocessed.transcript).toBeUndefined();
    expect(preprocessed.isGroup).toBe(true);
    expect(preprocessed.groupId).toBe("demo-chat:chat:456");
    expect(preprocessed.cfg).toBe(cfg);
  });

  it("maps sent context consistently for plugin/internal hooks", () => {
    const canonical = buildCanonicalSentMessageHookContext({
      accountId: "acc-1",
      channelId: "demo-chat",
      content: "reply",
      error: "network error",
      groupId: "demo-chat:chat:456",
      isGroup: true,
      messageId: "out-1",
      success: false,
      to: "demo-chat:chat:456",
    });

    expect(toPluginMessageContext(canonical)).toEqual({
      accountId: "acc-1",
      channelId: "demo-chat",
      conversationId: "demo-chat:chat:456",
    });
    expect(toPluginMessageSentEvent(canonical)).toEqual({
      content: "reply",
      error: "network error",
      success: false,
      to: "demo-chat:chat:456",
    });
    expect(toInternalMessageSentContext(canonical)).toEqual({
      accountId: "acc-1",
      channelId: "demo-chat",
      content: "reply",
      conversationId: "demo-chat:chat:456",
      error: "network error",
      groupId: "demo-chat:chat:456",
      isGroup: true,
      messageId: "out-1",
      success: false,
      to: "demo-chat:chat:456",
    });
  });
});
