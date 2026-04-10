import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { feishuPlugin } from "./channel.js";
import { looksLikeFeishuId, normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const editMessageFeishuMock = vi.hoisted(() => vi.fn());
const createPinFeishuMock = vi.hoisted(() => vi.fn());
const listPinsFeishuMock = vi.hoisted(() => vi.fn());
const removePinFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const getChatMembersMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryPeersLiveMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryGroupsLiveMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    createPinFeishu: createPinFeishuMock,
    editMessageFeishu: editMessageFeishuMock,
    feishuOutbound: {
      sendMedia: feishuOutboundSendMediaMock,
      sendText: vi.fn(),
    },
    getChatInfo: getChatInfoMock,
    getChatMembers: getChatMembersMock,
    getFeishuMemberInfo: getFeishuMemberInfoMock,
    getMessageFeishu: getMessageFeishuMock,
    listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveMock,
    listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveMock,
    listPinsFeishu: listPinsFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    probeFeishu: probeFeishuMock,
    removePinFeishu: removePinFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    sendCardFeishu: sendCardFeishuMock,
    sendMessageFeishu: sendMessageFeishuMock,
  },
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

function getDescribedActions(cfg: OpenClawConfig, accountId?: string): string[] {
  return [...(feishuPlugin.actions?.describeMessageTool?.({ accountId, cfg })?.actions ?? [])];
}

function createLegacyFeishuButtonCard(value: { command?: string; text?: string }) {
  return {
    body: {
      elements: [
        {
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "Run /new" },
              value,
            },
          ],
          tag: "action",
        },
      ],
    },
    schema: "2.0",
  };
}

async function expectLegacyFeishuCardPayloadRejected(cfg: OpenClawConfig, card: unknown) {
  await expect(
    feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      params: { card, to: "chat:oc_group_1" },
      toolContext: {},
    } as never),
  ).rejects.toThrow(
    "Feishu card buttons that trigger text or commands must use structured interaction envelopes.",
  );
  expect(sendCardFeishuMock).not.toHaveBeenCalled();
}

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ appId: "cli_main", ok: true });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      cfg,
      timeoutMs: 1000,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ appId: "cli_main", ok: true });
  });
});

describe("feishuPlugin.pairing.notifyApproval", () => {
  beforeEach(() => {
    sendMessageFeishuMock.mockReset();
    sendMessageFeishuMock.mockResolvedValue({ chatId: "ou_user", messageId: "pairing-msg" });
  });

  it("preserves accountId when sending pairing approvals", async () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            work: {
              appId: "cli_work",
              appSecret: "secret_work",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    await feishuPlugin.pairing?.notifyApproval?.({
      accountId: "work",
      cfg,
      id: "ou_user",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        cfg,
        to: "ou_user",
      }),
    );
  });
});

describe("feishuPlugin messaging", () => {
  it("owns sender/topic session inheritance candidates", () => {
    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      }),
    ).toEqual({
      baseConversationId: "oc_group_chat",
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group_chat:topic:om_topic_root",
      }),
    ).toEqual({
      baseConversationId: "oc_group_chat",
      id: "oc_group_chat:topic:om_topic_root",
      parentConversationCandidates: ["oc_group_chat"],
    });
    expect(
      feishuPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: "oc_group_chat:Topic:om_topic_root:Sender:ou_topic_user",
      }),
    ).toEqual({
      baseConversationId: "oc_group_chat",
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
  });
});

describe("feishuPlugin actions", () => {
  const cfg = {
    channels: {
      feishu: {
        actions: {
          reactions: true,
        },
        appId: "cli_main",
        appSecret: "secret_main",
        enabled: true,
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
  });

  it("advertises the expanded Feishu action surface", () => {
    expect(getDescribedActions(cfg)).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
      "react",
      "reactions",
    ]);
  });

  it("does not advertise reactions when disabled via actions config", () => {
    const disabledCfg = {
      channels: {
        feishu: {
          actions: {
            reactions: false,
          },
          appId: "cli_main",
          appSecret: "secret_main",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    expect(getDescribedActions(disabledCfg)).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
    ]);
  });

  it("honors the selected Feishu account during discovery", () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            default: {
              actions: { reactions: false },
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
            work: {
              actions: { reactions: true },
              appId: "cli_work",
              appSecret: "secret_work",
              enabled: true,
            },
          },
          actions: { reactions: false },
          enabled: true,
        },
      },
    } as OpenClawConfig;

    expect(getDescribedActions(cfg, "default")).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
    ]);
    expect(getDescribedActions(cfg, "work")).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
      "react",
      "reactions",
    ]);
  });

  it("sends text messages", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ chatId: "oc_group_1", messageId: "om_sent" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      params: { message: "hello", to: "chat:oc_group_1" },
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      replyInThread: false,
      replyToMessageId: undefined,
      text: "hello",
      to: "chat:oc_group_1",
    });
    expect(result?.details).toMatchObject({ chatId: "oc_group_1", messageId: "om_sent", ok: true });
  });

  it("sends card messages", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ chatId: "oc_group_1", messageId: "om_card" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      params: { card: { schema: "2.0" }, to: "chat:oc_group_1" },
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      card: { schema: "2.0" },
      cfg,
      replyInThread: false,
      replyToMessageId: undefined,
      to: "chat:oc_group_1",
    });
    expect(result?.details).toMatchObject({ chatId: "oc_group_1", messageId: "om_card", ok: true });
  });

  it("allows structured card button payloads", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ chatId: "oc_group_1", messageId: "om_card" });
    const card = {
      body: {
        elements: [
          {
            actions: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "Run /new" },
                value: createFeishuCardInteractionEnvelope({
                  k: "quick",
                  a: "feishu.quick_actions.help",
                  q: "/help",
                  c: { u: "u123", h: "oc_group_1", t: "group", e: Date.now() + 60_000 },
                }),
              },
            ],
            tag: "action",
          },
        ],
      },
      schema: "2.0",
    };

    await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      params: { card, to: "chat:oc_group_1" },
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        card,
      }),
    );
  });

  it("rejects raw legacy card command payloads", async () => {
    await expectLegacyFeishuCardPayloadRejected(
      cfg,
      createLegacyFeishuButtonCard({ command: "/new" }),
    );
  });

  it("rejects raw legacy card text payloads", async () => {
    await expectLegacyFeishuCardPayloadRejected(
      cfg,
      createLegacyFeishuButtonCard({ text: "/new" }),
    );
  });

  it("allows non-button controls to carry text metadata values", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ chatId: "oc_group_1", messageId: "om_card" });
    const card = {
      body: {
        elements: [
          {
            actions: [
              {
                tag: "select_static",
                placeholder: { tag: "plain_text", content: "Pick one" },
                value: { text: "display-only metadata" },
                options: [
                  {
                    text: { tag: "plain_text", content: "Option A" },
                    value: "a",
                  },
                ],
              },
            ],
            tag: "action",
          },
        ],
      },
      schema: "2.0",
    };

    await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      params: { card, to: "chat:oc_group_1" },
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        card,
      }),
    );
  });

  it("sends media through the outbound adapter", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      details: { chatId: "oc_group_1", messageId: "om_media" },
      messageId: "om_media",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      mediaLocalRoots: ["/tmp"],
      params: {
        media: "/tmp/image.png",
        message: "test",
        to: "chat:oc_group_1",
      },
      toolContext: {},
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      mediaLocalRoots: ["/tmp"],
      mediaUrl: "/tmp/image.png",
      replyToId: undefined,
      text: "test",
      to: "chat:oc_group_1",
    });
    expect(result?.details).toMatchObject({ messageId: "om_media" });
  });

  it("reads messages", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      content: "hello",
      contentType: "text",
      messageId: "om_1",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "read",
      cfg,
      params: { messageId: "om_1" },
    } as never);

    expect(getMessageFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      messageId: "om_1",
    });
    expect(result?.details).toMatchObject({
      message: expect.objectContaining({ content: "hello", messageId: "om_1" }),
      ok: true,
    });
  });

  it("returns an error result when message reads fail", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(null);

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "read",
      cfg,
      params: { messageId: "om_missing" },
    } as never);

    expect((result as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect(result?.details).toEqual({
      error: "Feishu read failed or message not found: om_missing",
    });
  });

  it("edits messages", async () => {
    editMessageFeishuMock.mockResolvedValueOnce({ contentType: "post", messageId: "om_2" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "edit",
      cfg,
      params: { messageId: "om_2", text: "updated" },
    } as never);

    expect(editMessageFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      card: undefined,
      cfg,
      messageId: "om_2",
      text: "updated",
    });
    expect(result?.details).toMatchObject({ contentType: "post", messageId: "om_2", ok: true });
  });

  it("sends explicit thread replies with reply_in_thread semantics", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ chatId: "oc_group_1", messageId: "om_reply" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "thread-reply",
      cfg,
      params: { messageId: "om_parent", text: "reply body", to: "chat:oc_group_1" },
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      replyInThread: true,
      replyToMessageId: "om_parent",
      text: "reply body",
      to: "chat:oc_group_1",
    });
    expect(result?.details).toMatchObject({
      action: "thread-reply",
      messageId: "om_reply",
      ok: true,
    });
  });

  it("creates pins", async () => {
    createPinFeishuMock.mockResolvedValueOnce({ chatId: "oc_group_1", messageId: "om_pin" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "pin",
      cfg,
      params: { messageId: "om_pin" },
    } as never);

    expect(createPinFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      messageId: "om_pin",
    });
    expect(result?.details).toMatchObject({
      ok: true,
      pin: expect.objectContaining({ messageId: "om_pin" }),
    });
  });

  it("lists pins", async () => {
    listPinsFeishuMock.mockResolvedValueOnce({
      chatId: "oc_group_1",
      hasMore: false,
      pageToken: undefined,
      pins: [{ messageId: "om_pin" }],
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "list-pins",
      cfg,
      params: { chatId: "oc_group_1" },
      toolContext: {},
    } as never);

    expect(listPinsFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      chatId: "oc_group_1",
      endTime: undefined,
      pageSize: undefined,
      pageToken: undefined,
      startTime: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      pins: [expect.objectContaining({ messageId: "om_pin" })],
    });
  });

  it("removes pins", async () => {
    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "unpin",
      cfg,
      params: { messageId: "om_pin" },
    } as never);

    expect(removePinFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      messageId: "om_pin",
    });
    expect(result?.details).toMatchObject({ messageId: "om_pin", ok: true });
  });

  it("fetches channel info", async () => {
    getChatInfoMock.mockResolvedValueOnce({ chat_id: "oc_group_1", name: "Eng" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "channel-info",
      cfg,
      params: { chatId: "oc_group_1" },
      toolContext: {},
    } as never);

    expect(createFeishuClientMock).toHaveBeenCalled();
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
    expect(result?.details).toMatchObject({
      channel: expect.objectContaining({ chat_id: "oc_group_1", name: "Eng" }),
      ok: true,
    });
  });

  it("fetches member lists from a chat", async () => {
    getChatMembersMock.mockResolvedValueOnce({
      chat_id: "oc_group_1",
      has_more: false,
      members: [{ member_id: "ou_1", name: "Alice" }],
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "member-info",
      cfg,
      params: { chatId: "oc_group_1" },
      toolContext: {},
    } as never);

    expect(getChatMembersMock).toHaveBeenCalledWith(
      { tag: "client" },
      "oc_group_1",
      undefined,
      undefined,
      "open_id",
    );
    expect(result?.details).toMatchObject({
      members: [expect.objectContaining({ member_id: "ou_1", name: "Alice" })],
      ok: true,
    });
  });

  it("fetches individual member info", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "ou_1", name: "Alice" });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "member-info",
      cfg,
      params: { memberId: "ou_1" },
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "ou_1", "open_id");
    expect(result?.details).toMatchObject({
      member: expect.objectContaining({ member_id: "ou_1", name: "Alice" }),
      ok: true,
    });
  });

  it("infers user_id lookups from the userId alias", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "member-info",
      cfg,
      params: { userId: "u_1" },
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "u_1", "user_id");
  });

  it("honors explicit open_id over alias heuristics", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "member-info",
      cfg,
      params: { memberIdType: "open_id", userId: "u_1" },
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "u_1", "open_id");
  });

  it("lists directory-backed peers and groups", async () => {
    listFeishuDirectoryGroupsLiveMock.mockResolvedValueOnce([{ id: "oc_group_1", kind: "group" }]);
    listFeishuDirectoryPeersLiveMock.mockResolvedValueOnce([{ id: "ou_1", kind: "user" }]);

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "channel-list",
      cfg,
      params: { limit: 5, query: "eng" },
    } as never);

    expect(listFeishuDirectoryGroupsLiveMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      fallbackToStatic: false,
      limit: 5,
      query: "eng",
    });
    expect(listFeishuDirectoryPeersLiveMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      fallbackToStatic: false,
      limit: 5,
      query: "eng",
    });
    expect(result?.details).toMatchObject({
      groups: [expect.objectContaining({ id: "oc_group_1" })],
      ok: true,
      peers: [expect.objectContaining({ id: "ou_1" })],
    });
  });

  it("fails channel-list when live discovery fails", async () => {
    listFeishuDirectoryGroupsLiveMock.mockRejectedValueOnce(new Error("token expired"));

    await expect(
      feishuPlugin.actions?.handleAction?.({
        accountId: undefined,
        action: "channel-list",
        cfg,
        params: { limit: 5, query: "eng", scope: "groups" },
      } as never),
    ).rejects.toThrow("token expired");
  });

  it("requires clearAll=true before removing all bot reactions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        accountId: undefined,
        action: "react",
        cfg,
        params: { messageId: "om_msg1" },
      } as never),
    ).rejects.toThrow(
      "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
    );
  });

  it("allows explicit clearAll=true when removing all bot reactions", async () => {
    listReactionsFeishuMock.mockResolvedValueOnce([
      { operatorType: "app", reactionId: "r1" },
      { operatorType: "app", reactionId: "r2" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "react",
      cfg,
      params: { clearAll: true, messageId: "om_msg1" },
    } as never);

    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      accountId: undefined,
      cfg,
      messageId: "om_msg1",
    });
    expect(removeReactionFeishuMock).toHaveBeenCalledTimes(2);
    expect(result?.details).toMatchObject({ ok: true, removed: 2 });
  });

  it("fails for missing params on supported actions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        accountId: undefined,
        action: "thread-reply",
        cfg,
        params: { message: "reply body", to: "chat:oc_group_1" },
      } as never),
    ).rejects.toThrow("Feishu thread-reply requires messageId.");
  });

  it("sends media-only messages without requiring card", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      details: { chatId: "oc_group_1", messageId: "om_media_only" },
      messageId: "om_media_only",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      accountId: undefined,
      action: "send",
      cfg,
      mediaLocalRoots: [],
      params: {
        media: "https://example.com/image.png",
        to: "chat:oc_group_1",
      },
      toolContext: {},
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
        to: "chat:oc_group_1",
      }),
    );
    expect(result?.details).toMatchObject({ messageId: "om_media_only" });
  });

  it("fails for unsupported action names", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        accountId: undefined,
        action: "search",
        cfg,
        params: {},
      } as never),
    ).rejects.toThrow('Unsupported Feishu action: "search"');
  });
});

describe("resolveReceiveIdType", () => {
  it("resolves chat IDs by oc_ prefix", () => {
    expect(resolveReceiveIdType("oc_123")).toBe("chat_id");
  });

  it("resolves open IDs by ou_ prefix", () => {
    expect(resolveReceiveIdType("ou_123")).toBe("open_id");
  });

  it("defaults unprefixed IDs to user_id", () => {
    expect(resolveReceiveIdType("u_123")).toBe("user_id");
  });

  it("treats explicit group targets as chat_id", () => {
    expect(resolveReceiveIdType("group:oc_123")).toBe("chat_id");
  });

  it("treats explicit channel targets as chat_id", () => {
    expect(resolveReceiveIdType("channel:oc_123")).toBe("chat_id");
  });

  it("treats dm-prefixed open IDs as open_id", () => {
    expect(resolveReceiveIdType("dm:ou_123")).toBe("open_id");
  });
});

describe("normalizeFeishuTarget", () => {
  it("strips provider and user prefixes", () => {
    expect(normalizeFeishuTarget("feishu:user:ou_123")).toBe("ou_123");
    expect(normalizeFeishuTarget("lark:user:ou_123")).toBe("ou_123");
  });

  it("strips provider and chat prefixes", () => {
    expect(normalizeFeishuTarget("feishu:chat:oc_123")).toBe("oc_123");
  });

  it("normalizes group/channel prefixes to chat ids", () => {
    expect(normalizeFeishuTarget("group:oc_123")).toBe("oc_123");
    expect(normalizeFeishuTarget("feishu:group:oc_123")).toBe("oc_123");
    expect(normalizeFeishuTarget("channel:oc_456")).toBe("oc_456");
    expect(normalizeFeishuTarget("lark:channel:oc_456")).toBe("oc_456");
  });

  it("accepts provider-prefixed raw ids", () => {
    expect(normalizeFeishuTarget("feishu:ou_123")).toBe("ou_123");
  });

  it("strips provider and dm prefixes", () => {
    expect(normalizeFeishuTarget("lark:dm:ou_123")).toBe("ou_123");
  });
});

describe("looksLikeFeishuId", () => {
  it("accepts provider-prefixed user targets", () => {
    expect(looksLikeFeishuId("feishu:user:ou_123")).toBe(true);
  });

  it("accepts provider-prefixed chat targets", () => {
    expect(looksLikeFeishuId("lark:chat:oc_123")).toBe(true);
  });

  it("accepts group/channel targets", () => {
    expect(looksLikeFeishuId("feishu:group:oc_123")).toBe(true);
    expect(looksLikeFeishuId("group:oc_123")).toBe(true);
    expect(looksLikeFeishuId("channel:oc_456")).toBe(true);
  });
});
