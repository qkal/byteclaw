import { beforeEach, describe, expect, it, vi } from "vitest";
import { twitchMessageActions } from "./actions.js";
import { resolveTwitchAccountContext } from "./config.js";
import { twitchOutbound } from "./outbound.js";

vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

vi.mock("./outbound.js", () => ({
  twitchOutbound: {
    sendText: vi.fn(),
  },
}));

describe("twitchMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses configured defaultAccount when action accountId is omitted", async () => {
    vi.mocked(resolveTwitchAccountContext)
      .mockImplementationOnce(() => ({
        account: {
          accessToken: "oauth:secondary-token",
          channel: "secondary-channel",
          clientId: "secondary-client",
          enabled: true,
          username: "secondary",
        },
        accountId: "secondary",
        availableAccountIds: ["default", "secondary"],
        configured: true,
        tokenResolution: { source: "config", token: "oauth:secondary-token" },
      }))
      .mockImplementation((_cfg, accountId) => ({
        account: {
          accessToken: "oauth:secondary-token",
          channel: "secondary-channel",
          clientId: "secondary-client",
          enabled: true,
          username: "secondary",
        },
        accountId: accountId?.trim() || "secondary",
        availableAccountIds: ["default", "secondary"],
        configured: true,
        tokenResolution: { source: "config", token: "oauth:secondary-token" },
      }));
    const { sendText } = twitchOutbound;
    if (!sendText) {
      throw new Error("twitchOutbound.sendText is unavailable");
    }
    vi.mocked(sendText).mockResolvedValue({
      channel: "twitch",
      messageId: "msg-1",
      timestamp: 1,
    });

    await twitchMessageActions.handleAction!({
      action: "send",
      cfg: {
        channels: {
          twitch: {
            defaultAccount: "secondary",
          },
        },
      },
      params: { message: "Hello!" },
    } as never);

    expect(twitchOutbound.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "secondary",
        to: "secondary-channel",
      }),
    );
  });
});
