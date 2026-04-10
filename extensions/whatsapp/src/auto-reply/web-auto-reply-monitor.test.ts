import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMentionConfig } from "./mentions.js";
import { type GroupHistoryEntry, applyGroupGating } from "./monitor/group-gating.js";
import { buildInboundLine, formatReplyContext } from "./monitor/message-line.js";

let sessionDir: string | undefined;
let sessionStorePath: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-group-gating-"));
  sessionStorePath = path.join(sessionDir, "sessions.json");
  await fs.writeFile(sessionStorePath, "{}");
});

afterEach(async () => {
  if (sessionDir) {
    await fs.rm(sessionDir, { force: true, recursive: true });
    sessionDir = undefined;
  }
});

const makeConfig = (overrides: Record<string, unknown>) =>
  ({
    channels: {
      whatsapp: {
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
      },
    },
    session: { store: sessionStorePath },
    ...overrides,
  }) as unknown as ReturnType<typeof import("openclaw/plugin-sdk/config-runtime").loadConfig>;

function runGroupGating(params: {
  cfg: ReturnType<typeof import("openclaw/plugin-sdk/config-runtime").loadConfig>;
  msg: Record<string, unknown>;
  conversationId?: string;
  agentId?: string;
  selfChatMode?: boolean;
}) {
  const groupHistories = new Map<string, GroupHistoryEntry[]>();
  const conversationId = params.conversationId ?? "123@g.us";
  const agentId = params.agentId ?? "main";
  const sessionKey = `agent:${agentId}:whatsapp:group:${conversationId}`;
  const baseMentionConfig = buildMentionConfig(params.cfg, undefined);
  const result = applyGroupGating({
    agentId,
    baseMentionConfig,
    cfg: params.cfg,
    conversationId,
    groupHistories,
    groupHistoryKey: `whatsapp:default:group:${conversationId}`,
    groupHistoryLimit: 10,
    groupMemberNames: new Map(),
    logVerbose: () => {},
    msg: params.msg as any,
    replyLogger: { debug: () => {} },
    selfChatMode: params.selfChatMode,
    sessionKey,
  });
  return { groupHistories, result };
}

function createGroupMessage(overrides: Record<string, unknown> = {}) {
  return {
    body: "hello group",
    chatId: "123@g.us",
    chatType: "group",
    conversationId: "123@g.us",
    from: "123@g.us",
    id: "g1",
    reply: async () => {},
    selfE164: "+999",
    sendComposing: async () => {},
    sendMedia: async () => {},
    senderE164: "+111",
    senderName: "Alice",
    to: "+2",
    ...overrides,
  };
}

function makeOwnerGroupConfig() {
  return makeConfig({
    channels: {
      whatsapp: {
        allowFrom: ["+111"],
        groups: { "*": { requireMention: true } },
      },
    },
  });
}

function makeInboundCfg(messagePrefix = "") {
  return {
    agents: { defaults: { workspace: "/tmp/openclaw" } },
    channels: { whatsapp: { messagePrefix } },
  } as never;
}

describe("applyGroupGating", () => {
  it("treats reply-to-bot as implicit mention", () => {
    const cfg = makeConfig({});
    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        accountId: "default",
        body: "following up",
        id: "m1",
        replyToBody: "bot said hi",
        replyToId: "m0",
        replyToSender: "+15551234567",
        replyToSenderE164: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
        timestamp: Date.now(),
        to: "+15550000",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not treat self-number quoted replies as implicit mention in selfChatMode groups", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
          selfChatMode: true,
        },
      },
    });
    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        accountId: "default",
        body: "following up on my own message",
        id: "m-self-reply",
        replyToBody: "my earlier message",
        replyToId: "m0",
        replyToSender: "+15551234567",
        replyToSenderE164: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
        senderE164: "+15551234567",
        senderJid: "15551234567@s.whatsapp.net",
        timestamp: Date.now(),
        to: "+15550000",
      }),
      selfChatMode: true,
    });

    expect(result.shouldProcess).toBe(false);
  });

  it("still treats reply-to-bot as implicit mention in selfChatMode when sender is a different user", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
          selfChatMode: true,
        },
      },
    });
    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        accountId: "default",
        body: "following up on bot reply",
        id: "m-other-reply",
        replyToBody: "bot earlier response",
        replyToId: "m0",
        replyToSender: "+15551234567",
        replyToSenderE164: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
        senderE164: "+15559999999",
        senderJid: "15559999999@s.whatsapp.net",
        timestamp: Date.now(),
        to: "+15550000",
      }),
      selfChatMode: true,
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("honors per-account selfChatMode overrides before suppressing implicit mentions", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              selfChatMode: false,
            },
          },
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
          selfChatMode: true,
        },
      },
    });
    // Per-account override: work account has selfChatMode: false despite root being true
    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        accountId: "work",
        body: "following up on bot reply",
        id: "m-account-override",
        replyToBody: "bot earlier response",
        replyToId: "m0",
        replyToSender: "+15551234567",
        replyToSenderE164: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
        senderE164: "+15551234567",
        senderJid: "15551234567@s.whatsapp.net",
        timestamp: Date.now(),
        to: "+15550000",
      }),
      selfChatMode: false,
    });

    expect(result.shouldProcess).toBe(true);
  });

  it.each([
    { command: "/new", id: "g-new" },
    { command: "/status", id: "g-status" },
  ])("bypasses mention gating for owner $command in group chats", ({ id, command }) => {
    const { result } = runGroupGating({
      cfg: makeOwnerGroupConfig(),
      msg: createGroupMessage({
        body: command,
        id,
        senderE164: "+111",
        senderName: "Owner",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not bypass mention gating for non-owner /new in group chats", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+999"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const { result, groupHistories } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        body: "/new",
        id: "g-new-unauth",
        senderE164: "+111",
        senderName: "NotOwner",
      }),
    });

    expect(result.shouldProcess).toBe(false);
    expect(groupHistories.get("whatsapp:default:group:123@g.us")?.length).toBe(1);
  });

  it("uses per-agent mention patterns for group gating (routing + mentionPatterns)", () => {
    const cfg = makeConfig({
      agents: {
        list: [
          {
            groupChat: { mentionPatterns: ["@workbot"] },
            id: "work",
          },
        ],
      },
      bindings: [
        {
          agentId: "work",
          match: {
            peer: { id: "123@g.us", kind: "group" },
            provider: "whatsapp",
          },
        },
      ],
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: true } },
        },
      },
      messages: {
        groupChat: { mentionPatterns: ["@global"] },
      },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      peer: { id: "123@g.us", kind: "group" },
    });
    expect(route.agentId).toBe("work");

    const { result: globalMention } = runGroupGating({
      agentId: route.agentId,
      cfg,
      msg: createGroupMessage({
        body: "@global ping",
        id: "g1",
        senderE164: "+111",
        senderName: "Alice",
      }),
    });
    expect(globalMention.shouldProcess).toBe(false);

    const { result: workMention } = runGroupGating({
      agentId: route.agentId,
      cfg,
      msg: createGroupMessage({
        body: "@workbot ping",
        id: "g2",
        senderE164: "+222",
        senderName: "Bob",
      }),
    });
    expect(workMention.shouldProcess).toBe(true);
  });

  it("allows group messages when whatsapp groups default disables mention gating", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });

    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage(),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("blocks group messages when whatsapp groups is set without a wildcard", () => {
    const cfg = makeConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          groups: {
            "999@g.us": { requireMention: false },
          },
        },
      },
    });

    const { result } = runGroupGating({
      cfg,
      msg: createGroupMessage({
        body: "@workbot ping",
        mentionedJids: ["999@s.whatsapp.net"],
        selfJid: "999@s.whatsapp.net",
      }),
    });

    expect(result.shouldProcess).toBe(false);
  });
});

describe("buildInboundLine", () => {
  it("prefixes group messages with sender", () => {
    const line = buildInboundLine({
      agentId: "main",
      cfg: makeInboundCfg(""),
      msg: createGroupMessage({
        accountId: "default",
        body: "ping",
        senderE164: "+15550001111",
        senderJid: "111@s.whatsapp.net",
        senderName: "Bob",
        timestamp: 1700000000000,
        to: "+15550009999",
      }) as never,
    });

    expect(line).toContain("Bob (+15550001111):");
    expect(line).toContain("ping");
  });

  it("includes reply-to context blocks when replyToBody is present", () => {
    const line = buildInboundLine({
      agentId: "main",
      cfg: makeInboundCfg(""),
      envelope: { includeTimestamp: false },
      msg: {
        body: "hello",
        chatType: "direct",
        from: "+1555",
        replyToBody: "original",
        replyToId: "q1",
        replyToSender: "+1999",
        to: "+1555",
      } as never,
    });

    expect(line).toContain("[Replying to +1999 id:q1]");
    expect(line).toContain("original");
    expect(line).toContain("[/Replying]");
  });

  it("applies the WhatsApp messagePrefix when configured", () => {
    const line = buildInboundLine({
      agentId: "main",
      cfg: makeInboundCfg("[PFX]"),
      envelope: { includeTimestamp: false },
      msg: {
        body: "ping",
        chatType: "direct",
        from: "+1555",
        to: "+2666",
      } as never,
    });

    expect(line).toContain("[PFX] ping");
  });

  it("normalizes direct from labels by stripping whatsapp: prefix", () => {
    const line = buildInboundLine({
      agentId: "main",
      cfg: makeInboundCfg(""),
      envelope: { includeTimestamp: false },
      msg: {
        body: "ping",
        chatType: "direct",
        from: "whatsapp:+15550001111",
        to: "+2666",
      } as never,
    });

    expect(line).toContain("+15550001111");
    expect(line).not.toContain("whatsapp:+15550001111");
  });
});

describe("formatReplyContext", () => {
  it("returns null when replyToBody is missing", () => {
    expect(formatReplyContext({} as never)).toBeNull();
  });

  it("uses unknown sender label when reply sender is absent", () => {
    expect(
      formatReplyContext({
        replyToBody: "original",
      } as never),
    ).toBe("[Replying to unknown sender]\noriginal\n[/Replying]");
  });
});
