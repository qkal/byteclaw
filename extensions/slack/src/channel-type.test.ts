import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSlackChannelTypeCacheForTest, resolveSlackChannelType } from "./channel-type.js";

const conversationsInfoMock = vi.fn();

vi.mock("./client.js", () => ({
  createSlackWebClient: vi.fn(() => ({
    conversations: {
      info: conversationsInfoMock,
    },
  })),
}));

describe("resolveSlackChannelType", () => {
  beforeEach(() => {
    conversationsInfoMock.mockReset();
    __resetSlackChannelTypeCacheForTest();
  });

  it("uses configured defaultAccount for omitted-account cache keys", async () => {
    const channelId = "C123";

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              enabled: true,
            },
          },
        } as never,
        channelId,
      }),
    ).resolves.toBe("unknown");

    await expect(
      resolveSlackChannelType({
        cfg: {
          channels: {
            slack: {
              accounts: {
                work: {
                  appToken: "xapp-work",
                  botToken: "xoxb-work",
                  dm: {
                    groupChannels: [channelId],
                  },
                },
              },
              defaultAccount: "work",
              enabled: true,
            },
          },
        } as never,
        channelId,
      }),
    ).resolves.toBe("group");

    expect(conversationsInfoMock).not.toHaveBeenCalled();
  });
});
