import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMatrixAction } from "./tool-actions.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  applyMatrixProfileUpdate: vi.fn(),
  getMatrixMemberInfo: vi.fn(),
  getMatrixRoomInfo: vi.fn(),
  listMatrixPins: vi.fn(),
  listMatrixReactions: vi.fn(),
  reactMatrixMessage: vi.fn(),
  removeMatrixReactions: vi.fn(),
  sendMatrixMessage: vi.fn(),
  voteMatrixPoll: vi.fn(),
}));

vi.mock("./matrix/actions.js", () => ({
  getMatrixMemberInfo: mocks.getMatrixMemberInfo,
  getMatrixRoomInfo: mocks.getMatrixRoomInfo,
  listMatrixPins: mocks.listMatrixPins,
  listMatrixReactions: mocks.listMatrixReactions,
  removeMatrixReactions: mocks.removeMatrixReactions,
  sendMatrixMessage: mocks.sendMatrixMessage,
  voteMatrixPoll: mocks.voteMatrixPoll,
}));

vi.mock("./matrix/send.js", () => ({
  reactMatrixMessage: mocks.reactMatrixMessage,
}));

vi.mock("./profile-update.js", () => ({
  applyMatrixProfileUpdate: (...args: unknown[]) => mocks.applyMatrixProfileUpdate(...args),
}));

describe("handleMatrixAction pollVote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.voteMatrixPoll.mockResolvedValue({
      answerIds: ["a1", "a2"],
      eventId: "evt-poll-vote",
      labels: ["Pizza", "Sushi"],
      maxSelections: 2,
      pollId: "$poll",
      roomId: "!room:example",
    });
    mocks.listMatrixReactions.mockResolvedValue([{ count: 1, key: "👍", users: ["@u:example"] }]);
    mocks.listMatrixPins.mockResolvedValue({ events: [], pinned: ["$pin"] });
    mocks.removeMatrixReactions.mockResolvedValue({ removed: 1 });
    mocks.sendMatrixMessage.mockResolvedValue({
      messageId: "$sent",
      roomId: "!room:example",
    });
    mocks.getMatrixMemberInfo.mockResolvedValue({ userId: "@u:example" });
    mocks.getMatrixRoomInfo.mockResolvedValue({ roomId: "!room:example" });
    mocks.applyMatrixProfileUpdate.mockResolvedValue({
      accountId: "ops",
      avatarUrl: "mxc://example/avatar",
      configPath: "channels.matrix.accounts.ops",
      displayName: "Ops Bot",
      profile: {
        avatarUpdated: true,
        convertedAvatarFromHttp: false,
        displayNameUpdated: true,
        resolvedAvatarUrl: "mxc://example/avatar",
        uploadedAvatarSource: null,
      },
    });
  });

  it("parses snake_case vote params and forwards normalized selectors", async () => {
    const cfg = {} as CoreConfig;
    const result = await handleMatrixAction(
      {
        account_id: "main",
        action: "pollVote",
        poll_id: "$poll",
        poll_option_id: "a1",
        poll_option_ids: ["a2", ""],
        poll_option_index: "2",
        poll_option_indexes: ["1", "bogus"],
        room_id: "!room:example",
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      accountId: "main",
      cfg,
      optionIds: ["a2", "a1"],
      optionIndexes: [1, 2],
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        answerIds: ["a1", "a2"],
        eventId: "evt-poll-vote",
      },
    });
  });

  it("rejects missing poll ids", async () => {
    await expect(
      handleMatrixAction(
        {
          action: "pollVote",
          pollOptionIndex: 1,
          roomId: "!room:example",
        },
        {} as CoreConfig,
      ),
    ).rejects.toThrow("pollId required");
  });

  it("accepts messageId as a pollId alias for poll votes", async () => {
    const cfg = {} as CoreConfig;
    await handleMatrixAction(
      {
        action: "pollVote",
        messageId: "$poll",
        pollOptionIndex: 1,
        roomId: "!room:example",
      },
      cfg,
    );

    expect(mocks.voteMatrixPoll).toHaveBeenCalledWith("!room:example", "$poll", {
      cfg,
      optionIds: [],
      optionIndexes: [1],
    });
  });

  it("passes account-scoped opts to add reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "react",
        emoji: "👍",
        messageId: "$msg",
        roomId: "!room:example",
      },
      cfg,
    );

    expect(mocks.reactMatrixMessage).toHaveBeenCalledWith("!room:example", "$msg", "👍", {
      accountId: "ops",
      cfg,
    });
  });

  it("passes account-scoped opts to remove reactions", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        account_id: "ops",
        action: "react",
        emoji: "👍",
        message_id: "$msg",
        remove: true,
        room_id: "!room:example",
      },
      cfg,
    );

    expect(mocks.removeMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      accountId: "ops",
      cfg,
      emoji: "👍",
    });
  });

  it("passes account-scoped opts and limit to reaction listing", async () => {
    const cfg = { channels: { matrix: { actions: { reactions: true } } } } as CoreConfig;
    const result = await handleMatrixAction(
      {
        account_id: "ops",
        action: "reactions",
        limit: "5",
        message_id: "$msg",
        room_id: "!room:example",
      },
      cfg,
    );

    expect(mocks.listMatrixReactions).toHaveBeenCalledWith("!room:example", "$msg", {
      accountId: "ops",
      cfg,
      limit: 5,
    });
    expect(result.details).toMatchObject({
      ok: true,
      reactions: [{ count: 1, key: "👍" }],
    });
  });

  it("passes account-scoped opts to message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "sendMessage",
        content: "hello",
        threadId: "$thread",
        to: "room:!room:example",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", "hello", {
      accountId: "ops",
      cfg,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      mediaUrl: undefined,
      replyToId: undefined,
      threadId: "$thread",
    });
  });

  it("accepts media-only message sends", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "sendMessage",
        mediaUrl: "file:///tmp/photo.png",
        to: "room:!room:example",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      accountId: "ops",
      cfg,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      mediaUrl: "file:///tmp/photo.png",
      replyToId: undefined,
      threadId: undefined,
    });
  });

  it("accepts shared media aliases and voice-send flags", async () => {
    const cfg = { channels: { matrix: { actions: { messages: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "sendMessage",
        asVoice: true,
        path: "/tmp/clip.mp3",
        to: "room:!room:example",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.sendMatrixMessage).toHaveBeenCalledWith("room:!room:example", undefined, {
      accountId: "ops",
      audioAsVoice: true,
      cfg,
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      mediaUrl: "/tmp/clip.mp3",
      replyToId: undefined,
      threadId: undefined,
    });
  });

  it("passes mediaLocalRoots to profile updates", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "setProfile",
        avatarPath: "/tmp/avatar.jpg",
      },
      cfg,
      { mediaLocalRoots: ["/tmp/openclaw-matrix-test"] },
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "ops",
        avatarPath: "/tmp/avatar.jpg",
        cfg,
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
      }),
    );
  });

  it("passes account-scoped opts to pin listing", async () => {
    const cfg = { channels: { matrix: { actions: { pins: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "listPins",
        roomId: "!room:example",
      },
      cfg,
    );

    expect(mocks.listMatrixPins).toHaveBeenCalledWith("!room:example", {
      accountId: "ops",
      cfg,
    });
  });

  it("passes account-scoped opts to member and room info actions", async () => {
    const memberCfg = {
      channels: { matrix: { actions: { memberInfo: true } } },
    } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "memberInfo",
        roomId: "!room:example",
        userId: "@u:example",
      },
      memberCfg,
    );
    const roomCfg = { channels: { matrix: { actions: { channelInfo: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "channelInfo",
        roomId: "!room:example",
      },
      roomCfg,
    );

    expect(mocks.getMatrixMemberInfo).toHaveBeenCalledWith("@u:example", {
      accountId: "ops",
      cfg: memberCfg,
      roomId: "!room:example",
    });
    expect(mocks.getMatrixRoomInfo).toHaveBeenCalledWith("!room:example", {
      accountId: "ops",
      cfg: roomCfg,
    });
  });

  it("persists self-profile updates through the shared profile helper", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    const result = await handleMatrixAction(
      {
        account_id: "ops",
        action: "setProfile",
        avatar_url: "mxc://example/avatar",
        display_name: "Ops Bot",
      },
      cfg,
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      account: "ops",
      avatarUrl: "mxc://example/avatar",
      cfg,
      displayName: "Ops Bot",
    });
    expect(result.details).toMatchObject({
      accountId: "ops",
      ok: true,
      profile: {
        avatarUpdated: true,
        displayNameUpdated: true,
      },
    });
  });

  it("accepts local avatar paths for self-profile updates", async () => {
    const cfg = { channels: { matrix: { actions: { profile: true } } } } as CoreConfig;
    await handleMatrixAction(
      {
        accountId: "ops",
        action: "setProfile",
        path: "/tmp/avatar.jpg",
      },
      cfg,
    );

    expect(mocks.applyMatrixProfileUpdate).toHaveBeenCalledWith({
      account: "ops",
      avatarPath: "/tmp/avatar.jpg",
      avatarUrl: undefined,
      cfg,
      displayName: undefined,
    });
  });

  it("respects account-scoped action overrides when gating direct tool actions", async () => {
    await expect(
      handleMatrixAction(
        {
          accountId: "ops",
          action: "sendMessage",
          content: "hello",
          to: "room:!room:example",
        },
        {
          channels: {
            matrix: {
              accounts: {
                ops: {
                  actions: {
                    messages: false,
                  },
                },
              },
              actions: {
                messages: true,
              },
            },
          },
        } as CoreConfig,
      ),
    ).rejects.toThrow("Matrix messages are disabled.");
  });
});
