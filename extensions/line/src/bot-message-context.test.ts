import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "../../../test/helpers/plugins/plugin-registry.js";
import { lineBindingsAdapter } from "./bindings.js";
import { buildLineMessageContext, buildLinePostbackContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";

type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;

const lineBindingsPlugin = {
  bindings: lineBindingsAdapter,
  conversationBindings: {
    defaultTopLevelPlacement: "current",
    supportsCurrentConversationBinding: true,
  },
  id: "line",
};

describe("buildLineMessageContext", () => {
  let tmpDir: string;
  let storePath: string;
  let cfg: OpenClawConfig;
  const account: ResolvedLineAccount = {
    accountId: "default",
    channelAccessToken: "token",
    channelSecret: "secret",
    config: {},
    enabled: true,
    tokenSource: "config",
  };

  const createMessageEvent = (
    source: MessageEvent["source"],
    overrides?: Partial<MessageEvent>,
  ): MessageEvent =>
    ({
      deliveryContext: { isRedelivery: false },
      message: { id: "1", text: "hello", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source,
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-1",
      ...overrides,
    }) as MessageEvent;

  const createPostbackEvent = (
    source: PostbackEvent["source"],
    overrides?: Partial<PostbackEvent>,
  ): PostbackEvent =>
    ({
      deliveryContext: { isRedelivery: false },
      mode: "active",
      postback: { data: "action=select" },
      replyToken: "reply-token",
      source,
      timestamp: Date.now(),
      type: "postback",
      webhookEventId: "evt-2",
      ...overrides,
    }) as PostbackEvent;

  beforeEach(async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: lineBindingsPlugin,
          pluginId: lineBindingsPlugin.id,
          source: "test",
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-context-"));
    storePath = path.join(tmpDir, "sessions.json");
    cfg = { session: { store: storePath } };
  });

  afterEach(async () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    await fs.rm(tmpDir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    });
  });

  it("routes group message replies to the group id", async () => {
    const event = createMessageEvent({ groupId: "group-1", type: "group", userId: "user-1" });

    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg,
      commandAuthorized: true,
      event,
    });
    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("context missing");
    }

    expect(context.ctxPayload.OriginatingTo).toBe("line:group:group-1");
    expect(context.ctxPayload.To).toBe("line:group:group-1");
  });

  it("routes group postback replies to the group id", async () => {
    const event = createPostbackEvent({ groupId: "group-2", type: "group", userId: "user-2" });

    const context = await buildLinePostbackContext({
      account,
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:group:group-2");
    expect(context?.ctxPayload.To).toBe("line:group:group-2");
  });

  it("routes room postback replies to the room id", async () => {
    const event = createPostbackEvent({ roomId: "room-1", type: "room", userId: "user-3" });

    const context = await buildLinePostbackContext({
      account,
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:room:room-1");
    expect(context?.ctxPayload.To).toBe("line:room:room-1");
  });

  it("resolves prefixed-only group config through the inbound message context", async () => {
    const event = createMessageEvent({ groupId: "group-1", type: "group", userId: "user-1" });

    const context = await buildLineMessageContext({
      account: {
        ...account,
        config: {
          groups: {
            "group:group-1": {
              systemPrompt: "Use the prefixed group config",
            },
          },
        },
      },
      allMedia: [],
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context?.ctxPayload.GroupSystemPrompt).toBe("Use the prefixed group config");
  });

  it("resolves prefixed-only room config through the inbound message context", async () => {
    const event = createMessageEvent({ roomId: "room-1", type: "room", userId: "user-1" });

    const context = await buildLineMessageContext({
      account: {
        ...account,
        config: {
          groups: {
            "room:room-1": {
              systemPrompt: "Use the prefixed room config",
            },
          },
        },
      },
      allMedia: [],
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context?.ctxPayload.GroupSystemPrompt).toBe("Use the prefixed room config");
  });

  it("keeps non-text message contexts fail-closed for command auth", async () => {
    const event = createMessageEvent(
      { type: "user", userId: "user-audio" },
      {
        message: { duration: 1000, id: "audio-1", type: "audio" } as MessageEvent["message"],
      },
    );

    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg,
      commandAuthorized: false,
      event,
    });

    expect(context).not.toBeNull();
    expect(context?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("sets CommandAuthorized=true when authorized", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-auth" });

    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context?.ctxPayload.CommandAuthorized).toBe(true);
  });

  it("sets CommandAuthorized=false when not authorized", async () => {
    const event = createMessageEvent({ type: "user", userId: "user-noauth" });

    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg,
      commandAuthorized: false,
      event,
    });

    expect(context?.ctxPayload.CommandAuthorized).toBe(false);
  });

  it("sets CommandAuthorized on postback context", async () => {
    const event = createPostbackEvent({ type: "user", userId: "user-pb" });

    const context = await buildLinePostbackContext({
      account,
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context?.ctxPayload.CommandAuthorized).toBe(true);
  });

  it("group peer binding matches raw groupId without prefix (#21907)", async () => {
    const groupId = "Cc7e3bece1234567890abcdef"; // Pragma: allowlist secret
    const bindingCfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { id: "line-group-agent" }],
      },
      bindings: [
        {
          agentId: "line-group-agent",
          match: { channel: "line", peer: { id: groupId, kind: "group" } },
        },
      ],
      session: { store: storePath },
    };

    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "msg-1", text: "hello", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { groupId, type: "group", userId: "user-1" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-1",
    } as MessageEvent;

    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg: bindingCfg,
      commandAuthorized: true,
      event,
    });
    expect(context).not.toBeNull();
    expect(context!.route.agentId).toBe("line-group-agent");
    expect(context!.route.matchedBy).toBe("binding.peer");
  });

  it("room peer binding matches raw roomId without prefix (#21907)", async () => {
    const roomId = "Rr1234567890abcdef";
    const bindingCfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { id: "line-room-agent" }],
      },
      bindings: [
        {
          agentId: "line-room-agent",
          match: { channel: "line", peer: { id: roomId, kind: "group" } },
        },
      ],
      session: { store: storePath },
    };

    const event = {
      deliveryContext: { isRedelivery: false },
      message: { id: "msg-2", text: "hello", type: "text" },
      mode: "active",
      replyToken: "reply-token",
      source: { roomId, type: "room", userId: "user-2" },
      timestamp: Date.now(),
      type: "message",
      webhookEventId: "evt-2",
    } as MessageEvent;

    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg: bindingCfg,
      commandAuthorized: true,
      event,
    });
    expect(context).not.toBeNull();
    expect(context!.route.agentId).toBe("line-room-agent");
    expect(context!.route.matchedBy).toBe("binding.peer");
  });

  it("normalizes LINE ACP binding conversation ids through the plugin bindings surface", async () => {
    const compiled = lineBindingsAdapter.compileConfiguredBinding({
      conversationId: "line:user:U1234567890abcdef1234567890abcdef",
    });

    expect(compiled).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
      matchPriority: 2,
    });
  });

  it("normalizes canonical LINE targets through the plugin bindings surface", async () => {
    const compiled = lineBindingsAdapter.compileConfiguredBinding({
      conversationId: "line:U1234567890abcdef1234567890abcdef",
    });

    expect(compiled).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.resolveCommandConversation({
        originatingTo: "line:U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
    });
    expect(
      lineBindingsAdapter.matchInboundConversation({
        compiledBinding: compiled!,
        conversationId: "U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      conversationId: "U1234567890abcdef1234567890abcdef",
      matchPriority: 2,
    });
  });

  it("routes LINE conversations through active ACP session bindings", async () => {
    const userId = "U1234567890abcdef1234567890abcdef";
    await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "line",
        conversationId: userId,
      },
      metadata: {
        agentId: "codex",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:binding:line:default:test123",
    });

    const event = createMessageEvent({ type: "user", userId });
    const context = await buildLineMessageContext({
      account,
      allMedia: [],
      cfg,
      commandAuthorized: true,
      event,
    });

    expect(context).not.toBeNull();
    expect(context!.route.agentId).toBe("codex");
    expect(context!.route.sessionKey).toBe("agent:codex:acp:binding:line:default:test123");
    expect(context!.route.matchedBy).toBe("binding.channel");
  });
});
