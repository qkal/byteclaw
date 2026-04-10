import { MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectPairingReplyText } from "../../../test/helpers/pairing-reply.js";
import {
  dispatchMock,
  sendMock,
  upsertPairingRequestMock,
} from "./monitor.tool-result.test-harness.js";
import {
  BASE_CFG,
  type Config,
  createCategoryGuildClient,
  createCategoryGuildEvent,
  createCategoryGuildHandler,
  createDmClient,
  createDmHandler,
  resetDiscordToolResultHarness,
} from "./monitor.tool-result.test-helpers.js";

beforeEach(() => {
  resetDiscordToolResultHarness();
});

describe("discord tool result dispatch", () => {
  it("uses channel id allowlists for non-thread channels with categories", async () => {
    let capturedCtx: { SessionKey?: string } | undefined;
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedCtx = ctx;
      dispatcher.sendFinalReply({ text: "hi" });
      return { counts: { final: 1 }, queuedFinal: true };
    });

    const handler = await createCategoryGuildHandler();
    const client = createCategoryGuildClient();

    await handler(
      createCategoryGuildEvent({
        author: { bot: false, id: "u1", tag: "Ada#1", username: "Ada" },
        messageId: "m-category",
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:c1");
  });

  it("prefixes group bodies with sender label", async () => {
    let capturedBody = "";
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedBody = ctx.Body ?? "";
      dispatcher.sendFinalReply({ text: "ok" });
      return { counts: { final: 1 }, queuedFinal: true };
    });

    const handler = await createCategoryGuildHandler();
    const client = createCategoryGuildClient();

    await handler(
      createCategoryGuildEvent({
        author: { bot: false, discriminator: "1234", id: "u1", username: "Ada" },
        messageId: "m-prefix",
        timestamp: new Date("2026-01-17T00:00:00Z").toISOString(),
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(capturedBody).toContain("Ada (Ada#1234): hello");
  });

  it("replies with pairing code and sender id when dmPolicy is pairing", async () => {
    const cfg: Config = {
      ...BASE_CFG,
      channels: {
        discord: { dm: { allowFrom: [], enabled: true, policy: "pairing" } },
      },
    };

    const handler = await createDmHandler({ cfg });
    const client = createDmClient();

    await handler(
      {
        author: { bot: false, id: "u2", username: "Ada" },
        guild_id: null,
        message: {
          attachments: [],
          author: { bot: false, id: "u2", username: "Ada" },
          channelId: "c1",
          content: "hello",
          embeds: [],
          id: "m1",
          mentionedEveryone: false,
          mentionedRoles: [],
          mentionedUsers: [],
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
        },
      },
      client,
    );

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expectPairingReplyText(String(sendMock.mock.calls[0]?.[1] ?? ""), {
      channel: "discord",
      code: "PAIRCODE",
      idLine: "Your Discord user id: u2",
    });
  }, 10_000);
});
