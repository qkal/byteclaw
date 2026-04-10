import { beforeEach, describe, expect, it } from "vitest";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "../../../test/helpers/plugins/subagent-hooks.js";
import type { ClawdbotConfig, OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuSubagentHooks } from "./subagent-hooks.js";
import {
  createFeishuThreadBindingManager,
  __testing as threadBindingTesting,
} from "./thread-bindings.js";

const baseConfig: ClawdbotConfig = {
  channels: { feishu: {} },
  session: { mainKey: "main", scope: "per-sender" },
};

function registerHandlersForTest(config: Record<string, unknown> = baseConfig) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerFeishuSubagentHooks,
  });
}

describe("feishu subagent hook handlers", () => {
  beforeEach(() => {
    threadBindingTesting.resetFeishuThreadBindingsForTests();
  });

  it("binds a Feishu DM conversation on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");
    createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    const result = await handler(
      {
        agentId: "codex",
        childSessionKey: "agent:main:subagent:child",
        label: "banana",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "feishu",
          to: "user:ou_sender_1",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });

    const deliveryTargetHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    expect(
      deliveryTargetHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            to: "user:ou_sender_1",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toEqual({
      origin: {
        accountId: "work",
        channel: "feishu",
        to: "user:ou_sender_1",
      },
    });
  });

  it("preserves the original Feishu DM delivery target", async () => {
    const handlers = registerHandlersForTest();
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    manager.bindConversation({
      conversationId: "ou_sender_1",
      metadata: {
        boundBy: "system",
        deliveryTo: "chat:oc_dm_chat_1",
      },
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:chat-dm-child",
    });

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:chat-dm-child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            to: "chat:oc_dm_chat_1",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toEqual({
      origin: {
        accountId: "work",
        channel: "feishu",
        to: "chat:oc_dm_chat_1",
      },
    });
  });

  it("binds a Feishu topic conversation and preserves parent context", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    const result = await spawnHandler(
      {
        agentId: "codex",
        childSessionKey: "agent:main:subagent:topic-child",
        label: "topic-child",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "feishu",
          threadId: "om_topic_root",
          to: "chat:oc_group_chat",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toEqual({ status: "ok", threadBindingReady: true });
    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:topic-child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            threadId: "om_topic_root",
            to: "chat:oc_group_chat",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toEqual({
      origin: {
        accountId: "work",
        channel: "feishu",
        threadId: "om_topic_root",
        to: "chat:oc_group_chat",
      },
    });
  });

  it("uses the requester session binding to preserve sender-scoped topic conversations", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      metadata: {
        agentId: "codex",
        boundBy: "system",
        label: "parent",
      },
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
    });

    const reboundResult = await spawnHandler(
      {
        agentId: "codex",
        childSessionKey: "agent:main:subagent:sender-child",
        label: "sender-child",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "feishu",
          threadId: "om_topic_root",
          to: "chat:oc_group_chat",
        },
        threadRequested: true,
      },
      {
        requesterSessionKey: "agent:main:parent",
      },
    );

    expect(reboundResult).toEqual({ status: "ok", threadBindingReady: true });
    expect(manager.listBySessionKey("agent:main:subagent:sender-child")).toMatchObject([
      {
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        parentConversationId: "oc_group_chat",
      },
    ]);
    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:sender-child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            threadId: "om_topic_root",
            to: "chat:oc_group_chat",
          },
          requesterSessionKey: "agent:main:parent",
        },
        {},
      ),
    ).toEqual({
      origin: {
        accountId: "work",
        channel: "feishu",
        threadId: "om_topic_root",
        to: "chat:oc_group_chat",
      },
    });
  });

  it("prefers requester-matching bindings when multiple child bindings exist", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    await spawnHandler(
      {
        agentId: "codex",
        childSessionKey: "agent:main:subagent:shared",
        label: "shared",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "feishu",
          to: "user:ou_sender_1",
        },
        threadRequested: true,
      },
      {},
    );
    await spawnHandler(
      {
        agentId: "codex",
        childSessionKey: "agent:main:subagent:shared",
        label: "shared",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "feishu",
          to: "user:ou_sender_2",
        },
        threadRequested: true,
      },
      {},
    );

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:shared",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            to: "user:ou_sender_2",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toEqual({
      origin: {
        accountId: "work",
        channel: "feishu",
        to: "user:ou_sender_2",
      },
    });
  });

  it("fails closed when requester-session bindings remain ambiguous for the same topic", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      metadata: { boundBy: "system" },
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
    });
    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_2",
      metadata: { boundBy: "system" },
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
    });

    await expect(
      spawnHandler(
        {
          agentId: "codex",
          childSessionKey: "agent:main:subagent:ambiguous-child",
          label: "ambiguous-child",
          mode: "session",
          requester: {
            accountId: "work",
            channel: "feishu",
            threadId: "om_topic_root",
            to: "chat:oc_group_chat",
          },
          threadRequested: true,
        },
        {
          requesterSessionKey: "agent:main:parent",
        },
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("direct messages or topic conversations"),
      status: "error",
    });

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:ambiguous-child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            threadId: "om_topic_root",
            to: "chat:oc_group_chat",
          },
          requesterSessionKey: "agent:main:parent",
        },
        {},
      ),
    ).toBeUndefined();
  });

  it("fails closed when both topic-level and sender-scoped requester bindings exist", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const manager = createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root",
      metadata: { boundBy: "system" },
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
    });
    manager.bindConversation({
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      metadata: { boundBy: "system" },
      parentConversationId: "oc_group_chat",
      targetKind: "subagent",
      targetSessionKey: "agent:main:parent",
    });

    await expect(
      spawnHandler(
        {
          agentId: "codex",
          childSessionKey: "agent:main:subagent:mixed-topic-child",
          label: "mixed-topic-child",
          mode: "session",
          requester: {
            accountId: "work",
            channel: "feishu",
            threadId: "om_topic_root",
            to: "chat:oc_group_chat",
          },
          threadRequested: true,
        },
        {
          requesterSessionKey: "agent:main:parent",
        },
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("direct messages or topic conversations"),
      status: "error",
    });

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:mixed-topic-child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            threadId: "om_topic_root",
            to: "chat:oc_group_chat",
          },
          requesterSessionKey: "agent:main:parent",
        },
        {},
      ),
    ).toBeUndefined();
  });

  it("no-ops for non-Feishu channels and non-threaded spawns", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const endedHandler = getRequiredHookHandler(handlers, "subagent_ended");

    await expect(
      spawnHandler(
        {
          agentId: "codex",
          childSessionKey: "agent:main:subagent:child",
          mode: "run",
          requester: {
            accountId: "work",
            channel: "discord",
            to: "channel:123",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toBeUndefined();

    await expect(
      spawnHandler(
        {
          agentId: "codex",
          childSessionKey: "agent:main:subagent:child",
          mode: "run",
          requester: {
            accountId: "work",
            channel: "feishu",
            to: "user:ou_sender_1",
          },
          threadRequested: false,
        },
        {},
      ),
    ).resolves.toBeUndefined();

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "discord",
            to: "channel:123",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toBeUndefined();

    expect(
      endedHandler(
        {
          accountId: "work",
          reason: "done",
          targetKind: "subagent",
          targetSessionKey: "agent:main:subagent:child",
        },
        {},
      ),
    ).toBeUndefined();
  });

  it("returns an error for unsupported non-topic Feishu group conversations", async () => {
    const handler = getRequiredHookHandler(registerHandlersForTest(), "subagent_spawning");
    createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    await expect(
      handler(
        {
          agentId: "codex",
          childSessionKey: "agent:main:subagent:child",
          mode: "session",
          requester: {
            accountId: "work",
            channel: "feishu",
            to: "chat:oc_group_chat",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("direct messages or topic conversations"),
      status: "error",
    });
  });

  it("unbinds Feishu bindings on subagent_ended", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const endedHandler = getRequiredHookHandler(handlers, "subagent_ended");
    createFeishuThreadBindingManager({ accountId: "work", cfg: baseConfig });

    await spawnHandler(
      {
        agentId: "codex",
        childSessionKey: "agent:main:subagent:child",
        mode: "session",
        requester: {
          accountId: "work",
          channel: "feishu",
          to: "user:ou_sender_1",
        },
        threadRequested: true,
      },
      {},
    );

    endedHandler(
      {
        accountId: "work",
        reason: "done",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
      },
      {},
    );

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            to: "user:ou_sender_1",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toBeUndefined();
  });

  it("fails closed when the Feishu monitor-owned binding manager is unavailable", async () => {
    const handlers = registerHandlersForTest();
    const spawnHandler = getRequiredHookHandler(handlers, "subagent_spawning");
    const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");

    await expect(
      spawnHandler(
        {
          agentId: "codex",
          childSessionKey: "agent:main:subagent:no-manager",
          mode: "session",
          requester: {
            accountId: "work",
            channel: "feishu",
            to: "user:ou_sender_1",
          },
          threadRequested: true,
        },
        {},
      ),
    ).resolves.toMatchObject({
      error: expect.stringContaining("monitor is not active"),
      status: "error",
    });

    expect(
      deliveryHandler(
        {
          childSessionKey: "agent:main:subagent:no-manager",
          expectsCompletionMessage: true,
          requesterOrigin: {
            accountId: "work",
            channel: "feishu",
            to: "user:ou_sender_1",
          },
          requesterSessionKey: "agent:main:main",
        },
        {},
      ),
    ).toBeUndefined();
  });
});
