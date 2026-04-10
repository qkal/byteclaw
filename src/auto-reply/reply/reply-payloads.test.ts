import { describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

describe("filterMessagingToolMediaDuplicates", () => {
  it("strips mediaUrl when it matches sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "hello" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ mediaUrl: undefined, mediaUrls: undefined, text: "hello" }]);
  });

  it("preserves mediaUrl when it is not in sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ mediaUrl: "file:///tmp/photo.jpg", text: "hello" }],
      sentMediaUrls: ["file:///tmp/other.jpg"],
    });
    expect(result).toEqual([{ mediaUrl: "file:///tmp/photo.jpg", text: "hello" }]);
  });

  it("filters matching entries from mediaUrls array", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [
        {
          mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/b.jpg", "file:///tmp/c.jpg"],
          text: "gallery",
        },
      ],
      sentMediaUrls: ["file:///tmp/b.jpg"],
    });
    expect(result).toEqual([
      { mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/c.jpg"], text: "gallery" },
    ]);
  });

  it("clears mediaUrls when all entries match", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ mediaUrls: ["file:///tmp/a.jpg"], text: "gallery" }],
      sentMediaUrls: ["file:///tmp/a.jpg"],
    });
    expect(result).toEqual([{ mediaUrl: undefined, mediaUrls: undefined, text: "gallery" }]);
  });

  it("returns payloads unchanged when no media present", () => {
    const payloads = [{ text: "plain text" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toStrictEqual(payloads);
  });

  it("returns payloads unchanged when sentMediaUrls is empty", () => {
    const payloads = [{ mediaUrl: "file:///tmp/photo.jpg", text: "hello" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: [],
    });
    expect(result).toBe(payloads);
  });

  it("dedupes equivalent file and local path variants", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ mediaUrl: "/tmp/photo.jpg", text: "hello" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ mediaUrl: undefined, mediaUrls: undefined, text: "hello" }]);
  });

  it("dedupes encoded file:// paths against local paths", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ mediaUrl: "/tmp/photo one.jpg", text: "hello" }],
      sentMediaUrls: ["file:///tmp/photo%20one.jpg"],
    });
    expect(result).toEqual([{ mediaUrl: undefined, mediaUrls: undefined, text: "hello" }]);
  });
});

describe("shouldSuppressMessagingToolReplies", () => {
  const installTelegramSuppressionRegistry = () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              targetsMatchForReplySuppression: ({ originTarget, targetKey, targetThreadId }) => {
                const baseTarget = (value: string) =>
                  value
                    .replace(/^telegram:(group|channel):/u, "")
                    .replace(/^telegram:/u, "")
                    .replace(/:topic:.*$/u, "");
                const originTopic = originTarget.match(/:topic:([^:]+)$/u)?.[1];
                return (
                  baseTarget(originTarget) === baseTarget(targetKey) &&
                  (originTopic === undefined || originTopic === targetThreadId)
                );
              },
            },
          }),
          pluginId: "telegram-plugin",
          source: "test",
        },
      ]),
    );
  };

  it("suppresses when target provider is missing but target matches current provider route", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [{ provider: "", to: "123", tool: "message" }],
        originatingTo: "123",
      }),
    ).toBe(true);
  });

  it('suppresses when target provider uses "message" placeholder and target matches', () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [{ provider: "message", to: "123", tool: "message" }],
        originatingTo: "123",
      }),
    ).toBe(true);
  });

  it("does not suppress when providerless target does not match origin route", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [{ provider: "", to: "456", tool: "message" }],
        originatingTo: "123",
      }),
    ).toBe(false);
  });

  it("suppresses telegram topic-origin replies when explicit threadId matches", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [
          { provider: "telegram", threadId: "77", to: "-100123", tool: "message" },
        ],
        originatingTo: "telegram:group:-100123:topic:77",
      }),
    ).toBe(true);
  });

  it("does not suppress telegram topic-origin replies when explicit threadId differs", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [
          { provider: "telegram", threadId: "88", to: "-100123", tool: "message" },
        ],
        originatingTo: "telegram:group:-100123:topic:77",
      }),
    ).toBe(false);
  });

  it("does not suppress telegram topic-origin replies when target omits topic metadata", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [{ provider: "telegram", to: "-100123", tool: "message" }],
        originatingTo: "telegram:group:-100123:topic:77",
      }),
    ).toBe(false);
  });

  it("suppresses telegram replies when chatId matches but target forms differ", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [{ provider: "telegram", to: "-100123", tool: "message" }],
        originatingTo: "telegram:group:-100123",
      }),
    ).toBe(true);
  });

  it("suppresses telegram replies even when the active plugin registry omits telegram", () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        messagingToolSentTargets: [
          { provider: "telegram", threadId: "77", to: "-100123", tool: "message" },
        ],
        originatingTo: "telegram:group:-100123:topic:77",
      }),
    ).toBe(true);
  });
});
