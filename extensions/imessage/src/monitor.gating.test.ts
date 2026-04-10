import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./monitor/inbound-processing.js";
import { parseIMessageNotification } from "./monitor/parse-notification.js";
import type { IMessagePayload } from "./monitor/types.js";

function baseCfg(): OpenClawConfig {
  return {
    channels: {
      imessage: {
        allowFrom: ["*"],
        dmPolicy: "open",
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
      },
    },
    messages: {
      groupChat: { mentionPatterns: ["@openclaw"] },
    },
    session: { mainKey: "main" },
  } as unknown as OpenClawConfig;
}

function resolve(params: {
  cfg?: OpenClawConfig;
  message: IMessagePayload;
  storeAllowFrom?: string[];
}) {
  const cfg = params.cfg ?? baseCfg();
  const groupHistories = new Map();
  return resolveIMessageInboundDecision({
    accountId: "default",
    allowFrom: ["*"],
    bodyText: (params.message.text ?? "").trim(),
    cfg,
    dmPolicy: cfg.channels?.imessage?.dmPolicy ?? "pairing",
    groupAllowFrom: [],
    groupHistories,
    groupPolicy: cfg.channels?.imessage?.groupPolicy ?? "open",
    historyLimit: 0,
    message: params.message,
    messageText: (params.message.text ?? "").trim(),
    opts: {},
    storeAllowFrom: params.storeAllowFrom ?? [],
  });
}

function resolveDispatchDecision(params: {
  cfg: OpenClawConfig;
  message: IMessagePayload;
  groupHistories?: Parameters<typeof resolveIMessageInboundDecision>[0]["groupHistories"];
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
}) {
  const groupHistories = params.groupHistories ?? new Map();
  const decision = resolveIMessageInboundDecision({
    accountId: "default",
    allowFrom: params.allowFrom ?? ["*"],
    bodyText: params.message.text ?? "",
    cfg: params.cfg,
    dmPolicy: params.dmPolicy ?? "open",
    groupAllowFrom: params.groupAllowFrom ?? [],
    groupHistories,
    groupPolicy: params.groupPolicy ?? "open",
    historyLimit: 0,
    message: params.message,
    messageText: params.message.text ?? "",
    opts: {},
    storeAllowFrom: [],
  });
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected dispatch decision");
  }
  return { decision, groupHistories };
}

function buildDispatchContextPayload(params: { cfg: OpenClawConfig; message: IMessagePayload }) {
  const { cfg, message } = params;
  const { decision, groupHistories } = resolveDispatchDecision({ cfg, message });

  const { ctxPayload } = buildIMessageInboundContext({
    cfg,
    decision,
    groupHistories,
    historyLimit: 0,
    message,
  });

  return ctxPayload;
}

describe("imessage monitor gating + envelope builders", () => {
  it("parseIMessageNotification rejects malformed payloads", () => {
    expect(
      parseIMessageNotification({
        message: { chat_id: 1, sender: { nested: "nope" } },
      }),
    ).toBeNull();
  });

  it("parseIMessageNotification preserves destination_caller_id metadata", () => {
    expect(
      parseIMessageNotification({
        message: {
          destination_caller_id: "+15550002222",
          id: 1,
          is_from_me: true,
          sender: "+15550001111",
          text: "hello",
        },
      }),
    ).toMatchObject({
      destination_caller_id: "+15550002222",
    });
  });

  it("drops group messages without mention by default", () => {
    const decision = resolve({
      message: {
        chat_id: 99,
        id: 1,
        is_from_me: false,
        is_group: true,
        sender: "+15550001111",
        text: "hello group",
      },
    });
    expect(decision.kind).toBe("drop");
    if (decision.kind !== "drop") {
      throw new Error("expected drop decision");
    }
    expect(decision.reason).toBe("no mention");
  });

  it("dispatches group messages with mention and builds a group envelope", () => {
    const cfg = baseCfg();
    const message: IMessagePayload = {
      chat_id: 42,
      chat_name: "Lobster Squad",
      id: 3,
      is_from_me: false,
      is_group: true,
      participants: ["+1555", "+1556"],
      sender: "+15550002222",
      text: "@openclaw ping",
    };
    const ctxPayload = buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload.ChatType).toBe("group");
    expect(ctxPayload.SessionKey).toBe("agent:main:imessage:group:42");
    expect(String(ctxPayload.Body ?? "")).toContain("+15550002222:");
    expect(String(ctxPayload.Body ?? "")).not.toContain("[from:");
    expect(ctxPayload.To).toBe("chat_id:42");
  });

  it("includes reply-to context fields + suffix", () => {
    const cfg = baseCfg();
    const message: IMessagePayload = {
      chat_id: 55,
      id: 5,
      is_from_me: false,
      is_group: false,
      reply_to_id: 9001,
      reply_to_sender: "+15559998888",
      reply_to_text: "original message",
      sender: "+15550001111",
      text: "replying now",
    };
    const ctxPayload = buildDispatchContextPayload({ cfg, message });

    expect(ctxPayload.ReplyToId).toBe("9001");
    expect(ctxPayload.ReplyToBody).toBe("original message");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(String(ctxPayload.Body ?? "")).toContain("[Replying to +15559998888 id:9001]");
    expect(String(ctxPayload.Body ?? "")).toContain("original message");
  });

  it("drops group reply context from non-allowlisted senders in allowlist mode", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "allowlist";
    cfg.channels.imessage.contextVisibility = "allowlist";

    const message: IMessagePayload = {
      chat_id: 55,
      id: 6,
      is_from_me: false,
      is_group: true,
      reply_to_id: 9001,
      reply_to_sender: "+15559998888",
      reply_to_text: "blocked quote",
      sender: "+15550001111",
      text: "@openclaw replying now",
    };
    const { decision, groupHistories } = resolveDispatchDecision({
      allowFrom: ["*"],
      cfg,
      groupAllowFrom: ["+15550001111"],
      groupPolicy: "allowlist",
      message,
    });
    const { ctxPayload } = buildIMessageInboundContext({
      cfg,
      decision,
      groupHistories,
      historyLimit: 0,
      message,
    });

    expect(ctxPayload.ReplyToId).toBeUndefined();
    expect(ctxPayload.ReplyToBody).toBeUndefined();
    expect(ctxPayload.ReplyToSender).toBeUndefined();
    expect(String(ctxPayload.Body ?? "")).not.toContain("[Replying to");
  });

  it("keeps group reply context in allowlist_quote mode", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "allowlist";
    cfg.channels.imessage.contextVisibility = "allowlist_quote";

    const message: IMessagePayload = {
      chat_id: 55,
      id: 7,
      is_from_me: false,
      is_group: true,
      reply_to_id: 9001,
      reply_to_sender: "+15559998888",
      reply_to_text: "quoted context",
      sender: "+15550001111",
      text: "@openclaw replying now",
    };
    const { decision, groupHistories } = resolveDispatchDecision({
      allowFrom: ["*"],
      cfg,
      groupAllowFrom: ["+15550001111"],
      groupPolicy: "allowlist",
      message,
    });
    const { ctxPayload } = buildIMessageInboundContext({
      cfg,
      decision,
      groupHistories,
      historyLimit: 0,
      message,
    });

    expect(ctxPayload.ReplyToId).toBe("9001");
    expect(ctxPayload.ReplyToBody).toBe("quoted context");
    expect(ctxPayload.ReplyToSender).toBe("+15559998888");
    expect(String(ctxPayload.Body ?? "")).toContain("[Replying to +15559998888 id:9001]");
  });

  it("treats configured chat_id as a group session even when is_group is false", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groups = { "2": { requireMention: false } };

    const groupHistories = new Map();
    const message: IMessagePayload = {
      chat_id: 2,
      id: 14,
      is_from_me: false,
      is_group: false,
      sender: "+15550001111",
      text: "hello",
    };
    const { decision } = resolveDispatchDecision({ cfg, groupHistories, message });
    expect(decision.isGroup).toBe(true);
    expect(decision.route.sessionKey).toBe("agent:main:imessage:group:2");
  });

  it("allows group messages when requireMention is true but no mentionPatterns exist", () => {
    const cfg = baseCfg();
    cfg.messages ??= {};
    cfg.messages.groupChat ??= {};
    cfg.messages.groupChat.mentionPatterns = [];

    const groupHistories = new Map();
    const decision = resolveIMessageInboundDecision({
      accountId: "default",
      allowFrom: ["*"],
      bodyText: "hello group",
      cfg,
      dmPolicy: "open",
      groupAllowFrom: [],
      groupHistories,
      groupPolicy: "open",
      historyLimit: 0,
      message: {
        chat_id: 777,
        id: 12,
        is_from_me: false,
        is_group: true,
        sender: "+15550001111",
        text: "hello group",
      },
      messageText: "hello group",
      opts: {},
      storeAllowFrom: [],
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("blocks group messages when imessage.groups is set without a wildcard", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groups = { "99": { requireMention: false } };

    const groupHistories = new Map();
    const decision = resolveIMessageInboundDecision({
      accountId: "default",
      allowFrom: ["*"],
      bodyText: "@openclaw hello",
      cfg,
      dmPolicy: "open",
      groupAllowFrom: [],
      groupHistories,
      groupPolicy: "open",
      historyLimit: 0,
      message: {
        chat_id: 123,
        id: 13,
        is_from_me: false,
        is_group: true,
        sender: "+15550001111",
        text: "@openclaw hello",
      },
      messageText: "@openclaw hello",
      opts: {},
      storeAllowFrom: [],
    });
    expect(decision.kind).toBe("drop");
  });

  it("honors group allowlist and ignores pairing-store senders in groups", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "allowlist";

    const groupHistories = new Map();
    const denied = resolveIMessageInboundDecision({
      accountId: "default",
      allowFrom: ["*"],
      bodyText: "@openclaw hi",
      cfg,
      dmPolicy: "pairing",
      groupAllowFrom: ["chat_id:101"],
      groupHistories,
      groupPolicy: "allowlist",
      historyLimit: 0,
      message: {
        chat_id: 202,
        id: 3,
        is_from_me: false,
        is_group: true,
        sender: "+15550003333",
        text: "@openclaw hi",
      },
      messageText: "@openclaw hi",
      opts: {},
      storeAllowFrom: ["+15550003333"],
    });
    expect(denied.kind).toBe("drop");

    const allowed = resolveIMessageInboundDecision({
      accountId: "default",
      allowFrom: ["*"],
      bodyText: "@openclaw ok",
      cfg,
      dmPolicy: "pairing",
      groupAllowFrom: ["chat_id:101"],
      groupHistories,
      groupPolicy: "allowlist",
      historyLimit: 0,
      message: {
        chat_id: 101,
        id: 33,
        is_from_me: false,
        is_group: true,
        sender: "+15550003333",
        text: "@openclaw ok",
      },
      messageText: "@openclaw ok",
      opts: {},
      storeAllowFrom: ["+15550003333"],
    });
    expect(allowed.kind).toBe("dispatch");
  });

  it("blocks group messages when groupPolicy is disabled", () => {
    const cfg = baseCfg();
    cfg.channels ??= {};
    cfg.channels.imessage ??= {};
    cfg.channels.imessage.groupPolicy = "disabled";

    const groupHistories = new Map();
    const decision = resolveIMessageInboundDecision({
      accountId: "default",
      allowFrom: ["*"],
      bodyText: "@openclaw hi",
      cfg,
      dmPolicy: "open",
      groupAllowFrom: [],
      groupHistories,
      groupPolicy: "disabled",
      historyLimit: 0,
      message: {
        chat_id: 303,
        id: 10,
        is_from_me: false,
        is_group: true,
        sender: "+15550003333",
        text: "@openclaw hi",
      },
      messageText: "@openclaw hi",
      opts: {},
      storeAllowFrom: [],
    });
    expect(decision.kind).toBe("drop");
  });
});
