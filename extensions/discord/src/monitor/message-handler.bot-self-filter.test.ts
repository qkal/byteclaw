import { describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  DEFAULT_DISCORD_BOT_USER_ID,
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function createMessageData(authorId: string, channelId = "ch-1") {
  return {
    author: { bot: authorId === DEFAULT_DISCORD_BOT_USER_ID, id: authorId },
    channel_id: channelId,
    message: {
      author: { bot: authorId === DEFAULT_DISCORD_BOT_USER_ID, id: authorId },
      channel_id: channelId,
      content: "hello",
      id: "msg-1",
    },
  };
}

function createPreflightContext(channelId = "ch-1") {
  return createDiscordPreflightContext(channelId);
}

describe("createDiscordMessageHandler bot-self filter", () => {
  it("skips bot-own messages before the debounce queue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    await expect(
      handler(createMessageData(DEFAULT_DISCORD_BOT_USER_ID) as never, {} as never),
    ).resolves.toBeUndefined();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("enqueues non-bot messages for processing", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    await expect(
      handler(createMessageData("user-456") as never, {} as never),
    ).resolves.toBeUndefined();

    await flushAsyncWork();
    expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });
});
