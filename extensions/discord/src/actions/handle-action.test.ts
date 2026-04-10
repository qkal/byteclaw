import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    await handleDiscordMessageAction({
      action: "timeout",
      cfg: {
        channels: { discord: { actions: { moderation: true }, token: "tok" } },
      } as OpenClawConfig,
      params: {
        durationMin: 5,
        guildId: "guild-1",
        senderUserId: "spoofed-admin-id",
        userId: "user-2",
      },
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "timeout",
        durationMinutes: 5,
        guildId: "guild-1",
        senderUserId: "trusted-sender-id",
        userId: "user-2",
      }),
      expect.objectContaining({
        channels: {
          discord: expect.objectContaining({
            token: "tok",
          }),
        },
      }),
    );
  });

  it("falls back to toolContext.currentMessageId for reactions", async () => {
    await handleDiscordMessageAction({
      action: "react",
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      params: {
        channelId: "123",
        emoji: "ok",
      },
      toolContext: { currentMessageId: "9001" },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "react",
        channelId: "123",
        emoji: "ok",
        messageId: "9001",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("rejects reactions when no message id source is available", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "react",
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
        params: {
          channelId: "123",
          emoji: "ok",
        },
      }),
    ).rejects.toThrow(/messageId required/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });
});
