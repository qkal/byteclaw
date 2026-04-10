import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { __testing, createFeishuThreadBindingManager } from "./thread-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("Feishu thread bindings", () => {
  beforeEach(() => {
    __testing.resetFeishuThreadBindingsForTests();
  });

  it("registers current-placement adapter capabilities for Feishu", () => {
    createFeishuThreadBindingManager({ accountId: "default", cfg: baseCfg });

    expect(
      getSessionBindingService().getCapabilities({
        accountId: "default",
        channel: "feishu",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current"],
      unbindSupported: true,
    });
  });

  it("binds and resolves a Feishu topic conversation", async () => {
    createFeishuThreadBindingManager({ accountId: "default", cfg: baseCfg });

    const binding = await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
      metadata: {
        agentId: "codex",
        label: "codex-main",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
    });

    expect(binding.conversation.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "default",
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    )?.toMatchObject({
      metadata: expect.objectContaining({
        agentId: "codex",
        label: "codex-main",
      }),
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
    });
  });

  it("clears account-scoped bindings when the manager stops", async () => {
    const manager = createFeishuThreadBindingManager({ accountId: "default", cfg: baseCfg });

    await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
      metadata: {
        agentId: "codex",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
    });

    manager.stop();

    expect(
      getSessionBindingService().resolveByConversation({
        accountId: "default",
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    ).toBeNull();
  });
});
