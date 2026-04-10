import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { resolveChannelModelOverride } from "./model-overrides.js";

describe("resolveChannelModelOverride", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it.each([
    {
      expected: { matchKey: "-100123", model: "demo-provider/demo-parent-model" },
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      name: "matches parent group id when topic suffix is present",
    },
    {
      expected: { matchKey: "-100123:topic:99", model: "demo-provider/demo-topic-model" },
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "demo-provider/demo-parent-model",
                "-100123:topic:99": "demo-provider/demo-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      name: "prefers topic-specific match over parent group id",
    },
    {
      expected: { matchKey: "123", model: "demo-provider/demo-parent-model" },
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              "demo-thread": {
                "123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "demo-thread",
        groupId: "999",
        parentSessionKey: "agent:main:demo-thread:channel:123:thread:456",
      },
      name: "falls back to parent session key when thread id does not match",
    },
    {
      expected: {
        matchKey: "oc_group_chat:topic:om_topic_root",
        model: "demo-provider/demo-feishu-topic-model",
      },
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              feishu: {
                "oc_group_chat:topic:om_topic_root": "demo-provider/demo-feishu-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "feishu",
        groupId: "oc_group_chat:topic:om_topic_root",
      },
      name: "preserves feishu topic ids for direct matches",
    },
    {
      expected: {
        matchKey: "oc_group_chat:topic:om_topic_root",
        model: "demo-provider/demo-feishu-topic-model",
      },
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              feishu: {
                "oc_group_chat:topic:om_topic_root": "demo-provider/demo-feishu-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "feishu",
        groupId: "unrelated",
        parentSessionKey:
          "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      },
      name: "preserves feishu topic ids when falling back from parent session key",
    },
  ] as const)("$name", ({ input, expected }) => {
    const resolved = resolveChannelModelOverride(input);
    expect(resolved?.model).toBe(expected.model);
    expect(resolved?.matchKey).toBe(expected.matchKey);
  });

  it("passes channel kind to plugin-owned parent fallback resolution", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            capabilities: { chatTypes: ["group", "channel"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
            id: "channel-kind",
            messaging: {
              resolveSessionConversation: ({
                kind,
                rawId,
              }: {
                kind: "group" | "channel";
                rawId: string;
              }) => ({
                id: rawId,
                parentConversationCandidates: kind === "channel" ? ["thread-parent"] : [],
              }),
            },
            meta: {
              blurb: "test stub.",
              docsPath: "/channels/channel-kind",
              id: "channel-kind",
              label: "Channel Kind",
              selectionLabel: "Channel Kind",
            },
          },
          pluginId: "channel-kind",
          source: "test",
        },
      ]),
    );

    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            "channel-kind": {
              "thread-parent": "demo-provider/demo-channel-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "channel-kind",
      groupChatType: "channel",
      groupId: "thread-123",
    });

    expect(resolved?.model).toBe("demo-provider/demo-channel-model");
    expect(resolved?.matchKey).toBe("thread-parent");
  });

  it("keeps bundled Feishu parent fallback matching before registry bootstrap", () => {
    resetPluginRuntimeStateForTest();

    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            feishu: {
              "oc_group_chat:topic:om_topic_root": "demo-provider/demo-feishu-topic-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "feishu",
      groupId: "unrelated",
      parentSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
    });

    expect(resolved?.model).toBe("demo-provider/demo-feishu-topic-model");
    expect(resolved?.matchKey).toBe("oc_group_chat:topic:om_topic_root");
  });

  it("keeps mixed-case Feishu scoped markers when matching parent session fallbacks", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            feishu: {
              "oc_group_chat:topic:om_topic_root": "demo-provider/demo-feishu-topic-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "feishu",
      groupId: "unrelated",
      parentSessionKey:
        "agent:main:feishu:group:oc_group_chat:Topic:om_topic_root:Sender:ou_topic_user",
    });

    expect(resolved?.model).toBe("demo-provider/demo-feishu-topic-model");
    expect(resolved?.matchKey).toBe("oc_group_chat:topic:om_topic_root");
  });

  it("prefers parent conversation ids over channel-name fallbacks", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "#general": "demo-provider/demo-channel-name-model",
              "-100123": "demo-provider/demo-parent-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChannel: "#general",
      groupId: "-100123:topic:99",
    });

    expect(resolved?.model).toBe("demo-provider/demo-parent-model");
    expect(resolved?.matchKey).toBe("-100123");
  });
});
