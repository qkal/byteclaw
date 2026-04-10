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
let pinMessageMSTeams: GraphMessagesTestModule["pinMessageMSTeams"];
let reactMessageMSTeams: GraphMessagesTestModule["reactMessageMSTeams"];
let unpinMessageMSTeams: GraphMessagesTestModule["unpinMessageMSTeams"];
let unreactMessageMSTeams: GraphMessagesTestModule["unreactMessageMSTeams"];

beforeAll(async () => {
  ({ pinMessageMSTeams, reactMessageMSTeams, unpinMessageMSTeams, unreactMessageMSTeams } =
    await loadGraphMessagesTestModule());
});

describe("pinMessageMSTeams", () => {
  it("pins a message in a chat", async () => {
    mockState.postGraphJson.mockResolvedValue({ id: "pinned-1" });

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      to: CHAT_ID,
    });

    expect(result).toEqual({ ok: true, pinnedMessageId: "pinned-1" });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      body: { message: { id: "msg-1" } },
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages`,
      token: TOKEN,
    });
  });

  it("pins a message in a channel", async () => {
    mockState.postGraphJson.mockResolvedValue({});

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-2",
      to: CHANNEL_TO,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphJson).toHaveBeenCalledWith({
      body: { message: { id: "msg-2" } },
      path: "/teams/team-id-1/channels/channel-id-1/pinnedMessages",
      token: TOKEN,
    });
  });
});

describe("unpinMessageMSTeams", () => {
  it("unpins a message from a chat", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      pinnedMessageId: "pinned-1",
      to: CHAT_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages/pinned-1`,
      token: TOKEN,
    });
  });

  it("unpins a message from a channel", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      pinnedMessageId: "pinned-2",
      to: CHANNEL_TO,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      path: "/teams/team-id-1/channels/channel-id-1/pinnedMessages/pinned-2",
      token: TOKEN,
    });
  });
});

describe("reactMessageMSTeams", () => {
  it("sets a like reaction on a chat message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      reactionType: "like",
      to: CHAT_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      body: { reactionType: "like" },
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      token: TOKEN,
    });
  });

  it("sets a reaction on a channel message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-2",
      reactionType: "heart",
      to: CHANNEL_TO,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      body: { reactionType: "heart" },
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2/setReaction",
      token: TOKEN,
    });
  });

  it("normalizes reaction type to lowercase", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      reactionType: "LAUGH",
      to: CHAT_ID,
    });

    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      body: { reactionType: "laugh" },
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/setReaction`,
      token: TOKEN,
    });
  });

  it("rejects invalid reaction type", async () => {
    await expect(
      reactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        messageId: "msg-1",
        reactionType: "thumbsup",
        to: CHAT_ID,
      }),
    ).rejects.toThrow('Invalid reaction type "thumbsup"');
  });

  it("resolves user: target through conversation store", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-id",
      reference: { graphChatId: "19:dm-chat@thread.tacv2" },
    });
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    await reactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      reactionType: "like",
      to: "user:aad-user-1",
    });

    expect(mockState.findPreferredDmByUserId).toHaveBeenCalledWith("aad-user-1");
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      body: { reactionType: "like" },
      path: `/chats/${encodeURIComponent("19:dm-chat@thread.tacv2")}/messages/msg-1/setReaction`,
      token: TOKEN,
    });
  });
});

describe("unreactMessageMSTeams", () => {
  it("removes a reaction from a chat message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-1",
      reactionType: "sad",
      to: CHAT_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      body: { reactionType: "sad" },
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1/unsetReaction`,
      token: TOKEN,
    });
  });

  it("removes a reaction from a channel message", async () => {
    mockState.postGraphBetaJson.mockResolvedValue(undefined);

    const result = await unreactMessageMSTeams({
      cfg: {} as OpenClawConfig,
      messageId: "msg-2",
      reactionType: "angry",
      to: CHANNEL_TO,
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.postGraphBetaJson).toHaveBeenCalledWith({
      body: { reactionType: "angry" },
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2/unsetReaction",
      token: TOKEN,
    });
  });

  it("rejects invalid reaction type", async () => {
    await expect(
      unreactMessageMSTeams({
        cfg: {} as OpenClawConfig,
        messageId: "msg-1",
        reactionType: "clap",
        to: CHAT_ID,
      }),
    ).rejects.toThrow('Invalid reaction type "clap"');
  });
});
