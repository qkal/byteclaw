import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  resolveSessionConversation,
  resolveSessionConversationRef,
  resolveSessionParentSessionKey,
  resolveSessionThreadInfo,
} from "./session-conversation.js";

describe("session conversation routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("keeps generic :thread: parsing in core", () => {
    expect(
      resolveSessionConversationRef("agent:main:slack:channel:general:thread:1699999999.0001"),
    ).toEqual({
      baseConversationId: "general",
      baseSessionKey: "agent:main:slack:channel:general",
      channel: "slack",
      id: "general",
      kind: "channel",
      parentConversationCandidates: ["general"],
      rawId: "general:thread:1699999999.0001",
      threadId: "1699999999.0001",
    });
  });

  it("lets Telegram own :topic: session grammar", () => {
    expect(resolveSessionConversationRef("agent:main:telegram:group:-100123:topic:77")).toEqual({
      baseConversationId: "-100123",
      baseSessionKey: "agent:main:telegram:group:-100123",
      channel: "telegram",
      id: "-100123",
      kind: "group",
      parentConversationCandidates: ["-100123"],
      rawId: "-100123:topic:77",
      threadId: "77",
    });
    expect(resolveSessionThreadInfo("agent:main:telegram:group:-100123:topic:77")).toEqual({
      baseSessionKey: "agent:main:telegram:group:-100123",
      threadId: "77",
    });
    expect(resolveSessionParentSessionKey("agent:main:telegram:group:-100123:topic:77")).toBe(
      "agent:main:telegram:group:-100123",
    );
  });

  it("does not load bundled session-key fallbacks for inactive channel plugins", () => {
    resetPluginRuntimeStateForTest();

    expect(resolveSessionConversationRef("agent:main:telegram:group:-100123:topic:77")).toEqual({
      baseConversationId: "-100123:topic:77",
      baseSessionKey: "agent:main:telegram:group:-100123:topic:77",
      channel: "telegram",
      id: "-100123:topic:77",
      kind: "group",
      parentConversationCandidates: [],
      rawId: "-100123:topic:77",
      threadId: undefined,
    });
  });

  it("lets Feishu own parent fallback candidates", () => {
    expect(
      resolveSessionConversationRef(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseConversationId: "oc_group_chat",
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      channel: "feishu",
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      kind: "group",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
      rawId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
    expect(
      resolveSessionParentSessionKey(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toBeNull();
  });

  it("keeps the legacy parent-candidate hook as a fallback only", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            capabilities: { chatTypes: ["group"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
            id: "legacy-parent",
            messaging: {
              resolveParentConversationCandidates: ({ rawId }: { rawId: string }) =>
                rawId.endsWith(":sender:user") ? [rawId.replace(/:sender:user$/i, "")] : null,
            },
            meta: {
              blurb: "test stub.",
              docsPath: "/channels/legacy-parent",
              id: "legacy-parent",
              label: "Legacy Parent",
              selectionLabel: "Legacy Parent",
            },
          },
          pluginId: "legacy-parent",
          source: "test",
        },
      ]),
    );

    expect(
      resolveSessionConversation({
        channel: "legacy-parent",
        kind: "group",
        rawId: "room:sender:user",
      }),
    ).toEqual({
      baseConversationId: "room",
      id: "room:sender:user",
      parentConversationCandidates: ["room"],
      threadId: undefined,
    });
  });
});
