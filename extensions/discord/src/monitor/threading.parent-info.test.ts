import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDiscordChannelInfoCacheForTest } from "./message-utils.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

describe("resolveDiscordThreadParentInfo", () => {
  beforeEach(() => {
    __resetDiscordChannelInfoCacheForTest();
  });

  it("falls back to fetched thread parentId when parentId is missing in payload", async () => {
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === "thread-1") {
        return {
          id: "thread-1",
          name: "thread-name",
          parentId: "parent-1",
          type: ChannelType.PublicThread,
        };
      }
      if (channelId === "parent-1") {
        return {
          id: "parent-1",
          name: "parent-name",
          type: ChannelType.GuildText,
        };
      }
      return null;
    });

    const client = {
      fetchChannel,
    } as unknown as import("@buape/carbon").Client;

    const result = await resolveDiscordThreadParentInfo({
      channelInfo: null,
      client,
      threadChannel: {
        id: "thread-1",
        parentId: undefined,
      },
    });

    expect(fetchChannel).toHaveBeenCalledWith("thread-1");
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result).toEqual({
      id: "parent-1",
      name: "parent-name",
      type: ChannelType.GuildText,
    });
  });

  it("does not fetch thread info when parentId is already present", async () => {
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === "parent-1") {
        return {
          id: "parent-1",
          name: "parent-name",
          type: ChannelType.GuildText,
        };
      }
      return null;
    });

    const client = { fetchChannel } as unknown as import("@buape/carbon").Client;
    const result = await resolveDiscordThreadParentInfo({
      channelInfo: null,
      client,
      threadChannel: {
        id: "thread-1",
        parentId: "parent-1",
      },
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result).toEqual({
      id: "parent-1",
      name: "parent-name",
      type: ChannelType.GuildText,
    });
  });

  it("returns empty parent info when fallback thread lookup has no parentId", async () => {
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === "thread-1") {
        return {
          id: "thread-1",
          name: "thread-name",
          parentId: undefined,
          type: ChannelType.PublicThread,
        };
      }
      return null;
    });

    const client = { fetchChannel } as unknown as import("@buape/carbon").Client;
    const result = await resolveDiscordThreadParentInfo({
      channelInfo: null,
      client,
      threadChannel: {
        id: "thread-1",
        parentId: undefined,
      },
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith("thread-1");
    expect(result).toEqual({});
  });
});
