import { beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

const { discordOutbound } = await import("./outbound-adapter.js");

describe("discordOutbound shared interactive ordering", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    hoisted.sendDiscordComponentMessageMock.mockResolvedValue({
      channelId: "123456",
      messageId: "msg-1",
    });
  });

  it("keeps shared text blocks in authored order without hoisting fallback text", async () => {
    const result = await discordOutbound.sendPayload!({
      cfg: {},
      payload: {
        interactive: {
          blocks: [
            { text: "First", type: "text" },
            {
              buttons: [{ label: "Approve", value: "approve" }],
              type: "buttons",
            },
            { text: "Last", type: "text" },
          ],
        },
      },
      text: "",
      to: "channel:123456",
    });

    expect(hoisted.sendDiscordComponentMessageMock).toHaveBeenCalledWith(
      "channel:123456",
      {
        blocks: [
          { text: "First", type: "text" },
          {
            buttons: [{ callbackData: "approve", label: "Approve", style: "secondary" }],
            type: "actions",
          },
          { text: "Last", type: "text" },
        ],
      },
      expect.objectContaining({
        cfg: {},
      }),
    );
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      channelId: "123456",
      messageId: "msg-1",
    });
  });
});
