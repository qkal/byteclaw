import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  type FeishuReactionCreatedEvent,
  resolveReactionSyntheticEvent,
} from "./monitor.account.js";

const cfg = {} as ClawdbotConfig;

function makeReactionEvent(
  overrides: Partial<FeishuReactionCreatedEvent> = {},
): FeishuReactionCreatedEvent {
  return {
    message_id: "om_msg1",
    operator_type: "user",
    reaction_type: { emoji_type: "THUMBSUP" },
    user_id: { open_id: "ou_user1" },
    ...overrides,
  };
}

describe("Feishu reaction lifecycle", () => {
  it("builds a created synthetic interaction payload", async () => {
    const result = await resolveReactionSyntheticEvent({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg,
      event: makeReactionEvent(),
      fetchMessage: async () => ({
        chatId: "oc_group_1",
        chatType: "group",
        content: "hello",
        contentType: "text",
        messageId: "om_msg1",
        senderOpenId: "ou_bot",
        senderType: "app",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result?.message.content).toBe('{"text":"[reacted with THUMBSUP to message om_msg1]"}');
  });

  it("builds a deleted synthetic interaction payload", async () => {
    const result = await resolveReactionSyntheticEvent({
      accountId: "default",
      action: "deleted",
      botOpenId: "ou_bot",
      cfg,
      event: makeReactionEvent(),
      fetchMessage: async () => ({
        chatId: "oc_group_1",
        chatType: "group",
        content: "hello",
        contentType: "text",
        messageId: "om_msg1",
        senderOpenId: "ou_bot",
        senderType: "app",
      }),
      uuid: () => "fixed-uuid",
    });

    expect(result?.message.content).toBe(
      '{"text":"[removed reaction THUMBSUP from message om_msg1]"}',
    );
  });
});
