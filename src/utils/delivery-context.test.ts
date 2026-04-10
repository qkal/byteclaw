import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
  formatConversationTarget,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  resolveConversationDeliveryTarget,
} from "./delivery-context.js";

describe("delivery context helpers", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({ id: "room-chat", label: "Room chat" }),
            messaging: {
              resolveDeliveryTarget: ({
                conversationId,
                parentConversationId,
              }: {
                conversationId: string;
                parentConversationId?: string;
              }) =>
                conversationId.startsWith("$")
                  ? {
                      threadId: conversationId,
                      to: parentConversationId ? `room:${parentConversationId}` : undefined,
                    }
                  : {
                      to: `room:${conversationId}`,
                    },
            },
          },
          pluginId: "room-chat",
          source: "test",
        },
      ]),
    );
  });

  it("normalizes channel/to/accountId and drops empty contexts", () => {
    expect(
      normalizeDeliveryContext({
        accountId: " acct-1 ",
        channel: " demo-channel ",
        to: " +1555 ",
      }),
    ).toEqual({
      accountId: "acct-1",
      channel: "demo-channel",
      to: "+1555",
    });

    expect(normalizeDeliveryContext({ channel: "  " })).toBeUndefined();
  });

  it("does not inherit route fields from fallback when channels conflict", () => {
    const merged = mergeDeliveryContext(
      { channel: "demo-primary" },
      { accountId: "acct", channel: "demo-fallback", threadId: "99", to: "channel:def" },
    );

    expect(merged).toEqual({
      accountId: undefined,
      channel: "demo-primary",
      to: undefined,
    });
    expect(merged?.threadId).toBeUndefined();
  });

  it("inherits missing route fields when channels match", () => {
    const merged = mergeDeliveryContext(
      { channel: "demo-channel" },
      { accountId: "acct", channel: "demo-channel", threadId: "99", to: "123" },
    );

    expect(merged).toEqual({
      accountId: "acct",
      channel: "demo-channel",
      threadId: "99",
      to: "123",
    });
  });

  it("uses fallback route fields when fallback has no channel", () => {
    const merged = mergeDeliveryContext(
      { channel: "demo-channel" },
      { accountId: "acct", threadId: "99", to: "123" },
    );

    expect(merged).toEqual({
      accountId: "acct",
      channel: "demo-channel",
      threadId: "99",
      to: "123",
    });
  });

  it("builds stable keys only when channel and to are present", () => {
    expect(deliveryContextKey({ channel: "demo-channel", to: "+1555" })).toBe(
      "demo-channel|+1555||",
    );
    expect(deliveryContextKey({ channel: "demo-channel" })).toBeUndefined();
    expect(deliveryContextKey({ accountId: "acct-1", channel: "demo-channel", to: "+1555" })).toBe(
      "demo-channel|+1555|acct-1|",
    );
    expect(
      deliveryContextKey({ channel: "demo-channel", threadId: "123.456", to: "channel:C1" }),
    ).toBe("demo-channel|channel:C1||123.456");
  });

  it("formats generic fallback conversation targets as channels", () => {
    expect(formatConversationTarget({ channel: "demo-channel", conversationId: "123" })).toBe(
      "channel:123",
    );
  });

  it("formats plugin-defined conversation targets via channel messaging hooks", () => {
    expect(
      formatConversationTarget({ channel: "room-chat", conversationId: "!room:example" }),
    ).toBe("room:!room:example");
    expect(
      formatConversationTarget({
        channel: "room-chat",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toBe("room:!room:example");
    expect(
      formatConversationTarget({ channel: "room-chat", conversationId: "  " }),
    ).toBeUndefined();
  });

  it("resolves delivery targets for plugin-defined child threads", () => {
    expect(
      resolveConversationDeliveryTarget({
        channel: "room-chat",
        conversationId: "$thread",
        parentConversationId: "!room:example",
      }),
    ).toEqual({
      threadId: "$thread",
      to: "room:!room:example",
    });
  });

  it.each([
    {
      channel: "slack",
      conversationId: "1710000000.000100",
      expected: { threadId: "1710000000.000100", to: "channel:C123" },
      parentConversationId: "C123",
    },
    {
      channel: "telegram",
      conversationId: "42",
      expected: { threadId: "42", to: "channel:-10099" },
      parentConversationId: "-10099",
    },
    {
      channel: "mattermost",
      conversationId: "msg-child-id",
      expected: { threadId: "msg-child-id", to: "channel:channel-parent-id" },
      parentConversationId: "channel-parent-id",
    },
  ])(
    "resolves parent-scoped thread delivery targets for $channel",
    ({ channel, conversationId, parentConversationId, expected }) => {
      expect(
        resolveConversationDeliveryTarget({
          channel,
          conversationId,
          parentConversationId,
        }),
      ).toEqual(expected);
    },
  );

  it("derives delivery context from a session entry", () => {
    expect(
      deliveryContextFromSession({
        channel: "webchat",
        lastAccountId: " acct-9 ",
        lastChannel: " demo-channel ",
        lastTo: " +1777 ",
      }),
    ).toEqual({
      accountId: "acct-9",
      channel: "demo-channel",
      to: "+1777",
    });

    expect(
      deliveryContextFromSession({
        channel: "demo-channel",
        lastThreadId: " 999 ",
        lastTo: " 123 ",
      }),
    ).toEqual({
      accountId: undefined,
      channel: "demo-channel",
      threadId: "999",
      to: "123",
    });

    expect(
      deliveryContextFromSession({
        channel: "demo-channel",
        lastTo: " -1001 ",
        origin: { threadId: 42 },
      }),
    ).toEqual({
      accountId: undefined,
      channel: "demo-channel",
      threadId: 42,
      to: "-1001",
    });

    expect(
      deliveryContextFromSession({
        channel: "demo-channel",
        deliveryContext: { threadId: " 777 " },
        lastTo: " -1001 ",
        origin: { threadId: 42 },
      }),
    ).toEqual({
      accountId: undefined,
      channel: "demo-channel",
      threadId: "777",
      to: "-1001",
    });
  });

  it("normalizes delivery fields, mirrors session fields, and avoids cross-channel carryover", () => {
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        accountId: " acct-2 ",
        channel: " demo-fallback ",
        threadId: " 444 ",
        to: " channel:1 ",
      },
      lastChannel: " demo-primary ",
      lastTo: " +1555 ",
    });

    expect(normalized.deliveryContext).toEqual({
      accountId: undefined,
      channel: "demo-primary",
      to: "+1555",
    });
    expect(normalized.lastChannel).toBe("demo-primary");
    expect(normalized.lastTo).toBe("+1555");
    expect(normalized.lastAccountId).toBeUndefined();
    expect(normalized.lastThreadId).toBeUndefined();
  });
});
