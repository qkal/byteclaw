import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  type GraphMessagesTestModule,
  TOKEN,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let getMessageMSTeams: GraphMessagesTestModule["getMessageMSTeams"];
let listPinsMSTeams: GraphMessagesTestModule["listPinsMSTeams"];
let listReactionsMSTeams: GraphMessagesTestModule["listReactionsMSTeams"];

beforeAll(async () => {
  ({ getMessageMSTeams, listPinsMSTeams, listReactionsMSTeams } =
    await loadGraphMessagesTestModule());
});

describe("getMessageMSTeams", () => {
  it("resolves user: target using graphChatId from store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-framework-dm-id",
      reference: { graphChatId: "19:graph-native-chat@thread.tacv2" },
    });
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "From user DM" },
      createdDateTime: "2026-03-23T12:00:00Z",
      id: "msg-1",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: "user:aad-object-id-123",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-object-id-123");
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/chats/${encodeURIComponent("19:graph-native-chat@thread.tacv2")}/messages/msg-1`,
      token: TOKEN,
    });
  });

  it("falls back to conversationId when it starts with 19:", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "19:resolved-chat@thread.tacv2",
      reference: {},
    });
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "Hello" },
      createdDateTime: "2026-03-23T10:00:00Z",
      id: "msg-1",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: "user:aad-id",
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/chats/${encodeURIComponent("19:resolved-chat@thread.tacv2")}/messages/msg-1`,
      token: TOKEN,
    });
  });

  it("throws when user: target has no stored conversation", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue(null);

    await expect(
      getMessageMSTeams({
        cfg: {} as OpenClawConfig,
        messageId: "msg-1",
        to: "user:unknown-user",
      }),
    ).rejects.toThrow("No conversation found for user:unknown-user");
  });

  it("throws when user: target has Bot Framework ID and no graphChatId", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-framework-dm-id",
      reference: {},
    });

    await expect(
      getMessageMSTeams({
        cfg: {} as OpenClawConfig,
        messageId: "msg-1",
        to: "user:some-user",
      }),
    ).rejects.toThrow("Bot Framework ID");
  });

  it("strips conversation: prefix from target", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "Hello" },
      createdDateTime: "2026-03-23T10:00:00Z",
      from: undefined,
      id: "msg-1",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: `conversation:${CHAT_ID}`,
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
      token: TOKEN,
    });
  });

  it("reads a message from a chat conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "Hello world", contentType: "text" },
      createdDateTime: "2026-03-23T10:00:00Z",
      from: { user: { displayName: "Alice", id: "user-1" } },
      id: "msg-1",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: CHAT_ID,
    });

    expect(result).toEqual({
      createdAt: "2026-03-23T10:00:00Z",
      from: { user: { displayName: "Alice", id: "user-1" } },
      id: "msg-1",
      text: "Hello world",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
      token: TOKEN,
    });
  });

  it("reads a message from a channel conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "Channel message" },
      createdDateTime: "2026-03-23T11:00:00Z",
      from: { application: { displayName: "Bot", id: "app-1" } },
      id: "msg-2",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-2",
      to: CHANNEL_TO,
    });

    expect(result).toEqual({
      createdAt: "2026-03-23T11:00:00Z",
      from: { application: { displayName: "Bot", id: "app-1" } },
      id: "msg-2",
      text: "Channel message",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
      token: TOKEN,
    });
  });
});

describe("listPinsMSTeams", () => {
  it("lists pinned messages in a chat", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "pinned-1",
          message: { body: { content: "Pinned msg" }, id: "msg-1" },
        },
        {
          id: "pinned-2",
          message: { body: { content: "Another pin" }, id: "msg-2" },
        },
      ],
    });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([
      { id: "pinned-1", messageId: "msg-1", pinnedMessageId: "pinned-1", text: "Pinned msg" },
      { id: "pinned-2", messageId: "msg-2", pinnedMessageId: "pinned-2", text: "Another pin" },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages?$expand=message`,
      token: TOKEN,
    });
  });

  it("returns empty array when no pins exist", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([]);
  });
});

describe("listReactionsMSTeams", () => {
  it("lists reactions grouped by type with user details", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "Hello" },
      id: "msg-1",
      reactions: [
        { reactionType: "like", user: { displayName: "Alice", id: "u1" } },
        { reactionType: "like", user: { displayName: "Bob", id: "u2" } },
        { reactionType: "heart", user: { displayName: "Alice", id: "u1" } },
      ],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: CHAT_ID,
    });

    expect(result.reactions).toEqual([
      {
        count: 2,
        reactionType: "like",
        users: [
          { displayName: "Alice", id: "u1" },
          { displayName: "Bob", id: "u2" },
        ],
      },
      {
        count: 1,
        reactionType: "heart",
        users: [{ displayName: "Alice", id: "u1" }],
      },
    ]);
  });

  it("returns empty array when message has no reactions", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "No reactions" },
      id: "msg-1",
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: CHAT_ID,
    });

    expect(result.reactions).toEqual([]);
  });

  it("fetches from channel path for channel targets", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      body: { content: "Channel msg" },
      id: "msg-2",
      reactions: [{ reactionType: "surprised", user: { displayName: "Carol", id: "u3" } }],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-2",
      to: CHANNEL_TO,
    });

    expect(result.reactions).toEqual([
      { count: 1, reactionType: "surprised", users: [{ displayName: "Carol", id: "u3" }] },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
      token: TOKEN,
    });
  });
});
