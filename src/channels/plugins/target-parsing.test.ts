import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  comparableChannelTargetsMatch,
  comparableChannelTargetsShareRoute,
  parseExplicitTargetForChannel,
  resolveComparableTargetForChannel,
} from "./target-parsing.js";

function parseTelegramTargetForTest(raw: string): {
  to: string;
  threadId?: number;
  chatType?: "direct" | "group";
} {
  const trimmed = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^tg:/i, "");
  const prefixedTopic = /^group:([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (prefixedTopic) {
    return {
      chatType: "group",
      threadId: Number.parseInt(prefixedTopic[2], 10),
      to: prefixedTopic[1],
    };
  }
  const topic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (topic) {
    return {
      chatType: topic[1].startsWith("-") ? "group" : "direct",
      threadId: Number.parseInt(topic[2], 10),
      to: topic[1],
    };
  }
  return {
    chatType: trimmed.startsWith("-") ? "group" : undefined,
    to: trimmed,
  };
}

function setMinimalTargetParsingRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
          },
          id: "telegram",
          messaging: {
            parseExplicitTarget: ({ raw }: { raw: string }) => parseTelegramTargetForTest(raw),
          },
          meta: {
            blurb: "test stub",
            docsPath: "/channels/telegram",
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
          },
        },
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: {
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
          },
          id: "demo-target",
          messaging: {
            parseExplicitTarget: ({ raw }: { raw: string }) => ({
              chatType: "direct" as const,
              to: raw.trim().toUpperCase(),
            }),
          },
          meta: {
            blurb: "test stub",
            docsPath: "/channels/demo-target",
            id: "demo-target",
            label: "Demo Target",
            selectionLabel: "Demo Target",
          },
        },
        pluginId: "demo-target",
        source: "test",
      },
    ]),
  );
}

describe("parseExplicitTargetForChannel", () => {
  beforeEach(() => {
    setMinimalTargetParsingRegistry();
  });

  it("parses Telegram targets via the registered channel plugin contract", () => {
    expect(parseExplicitTargetForChannel("telegram", "telegram:group:-100123:topic:77")).toEqual({
      chatType: "group",
      threadId: 77,
      to: "-100123",
    });
    expect(parseExplicitTargetForChannel("telegram", "-100123")).toEqual({
      chatType: "group",
      to: "-100123",
    });
  });

  it("parses registered non-bundled channel targets via the active plugin contract", () => {
    expect(parseExplicitTargetForChannel("demo-target", "team-room")).toEqual({
      chatType: "direct",
      to: "TEAM-ROOM",
    });
  });

  it("builds comparable targets from plugin-owned grammar", () => {
    expect(
      resolveComparableTargetForChannel({
        channel: "telegram",
        rawTarget: "telegram:group:-100123:topic:77",
      }),
    ).toEqual({
      chatType: "group",
      rawTo: "telegram:group:-100123:topic:77",
      threadId: 77,
      to: "-100123",
    });
  });

  it("matches comparable targets when only the plugin grammar differs", () => {
    const topicTarget = resolveComparableTargetForChannel({
      channel: "telegram",
      rawTarget: "telegram:-100123:topic:77",
    });
    const bareTarget = resolveComparableTargetForChannel({
      channel: "telegram",
      rawTarget: "-100123",
    });

    expect(
      comparableChannelTargetsMatch({
        left: topicTarget,
        right: bareTarget,
      }),
    ).toBe(false);
    expect(
      comparableChannelTargetsShareRoute({
        left: topicTarget,
        right: bareTarget,
      }),
    ).toBe(true);
  });
});
