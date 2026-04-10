import "./lifecycle.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleFixture,
  createFeishuTextMessageEvent,
  expectFeishuSingleEffectAcrossReplay,
  installFeishuLifecycleReplyRuntime,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";
import type { ResolvedFeishuAccount } from "./types.js";

const {
  createEventDispatcherMock,
  dispatchReplyFromConfigMock,
  ensureConfiguredBindingRouteReadyMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  resolveConfiguredBindingRouteMock,
  sendMessageFeishuMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: RuntimeEnv | null = null;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const { cfg: lifecycleConfig, account: lifecycleAccount } = createFeishuLifecycleFixture({
  accountConfig: {
    groupPolicy: "open",
    groups: {
      oc_group_topic: {
        groupSessionScope: "group_topic",
        replyInThread: "enabled",
        requireMention: false,
      },
    },
  },
  accountId: "acct-acp",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    allowFrom: ["ou_sender_1"],
    groupPolicy: "open",
  },
  extraConfig: {
    session: { mainKey: "main", scope: "per-sender" },
  },
}) as {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
};

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuLifecycleHandler({
    account: lifecycleAccount,
    cfg: lifecycleConfig,
    createEventDispatcherMock,
    handlerKey: "im.message.receive_v1",
    missingHandlerMessage: "missing im.message.receive_v1 handler",
    onRegister: (registered) => {
      _handlers = registered;
    },
    runtime: lastRuntime,
  });
}

describe("Feishu ACP-init failure lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _handlers = {};
    lastRuntime = null;
    setFeishuLifecycleStateDir("openclaw-feishu-acp-failure");

    resolveBoundConversationMock.mockReturnValue(null);
    resolveAgentRouteMock.mockReturnValue({
      accountId: "acct-acp",
      agentId: "main",
      channel: "feishu",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:feishu:group:oc_group_topic",
    });
    resolveConfiguredBindingRouteMock.mockReturnValue({
      bindingResolution: {
        configuredBinding: {
          record: {
            bindingId: "config:acp:feishu:acct-acp:oc_group_topic:topic:om_topic_root_1",
            boundAt: 0,
            conversation: {
              accountId: "acct-acp",
              channel: "feishu",
              conversationId: "oc_group_topic:topic:om_topic_root_1",
              parentConversationId: "oc_group_topic",
            },
            metadata: { source: "config" },
            status: "active",
            targetKind: "session",
            targetSessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
          },
          spec: {
            accountId: "acct-acp",
            agentId: "codex",
            channel: "feishu",
            conversationId: "oc_group_topic:topic:om_topic_root_1",
            mode: "persistent",
          },
        },
        statefulTarget: {
          agentId: "codex",
          driverId: "acp",
          kind: "stateful",
          sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
        },
      },
      configuredBinding: {
        spec: {
          accountId: "acct-acp",
          agentId: "codex",
          channel: "feishu",
          conversationId: "oc_group_topic:topic:om_topic_root_1",
          mode: "persistent",
        },
      },
      route: {
        accountId: "acct-acp",
        agentId: "codex",
        channel: "feishu",
        mainSessionKey: "agent:codex:main",
        matchedBy: "binding.channel",
        sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
      },
    });
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      error: "runtime unavailable",
      ok: false,
    });

    dispatchReplyFromConfigMock.mockResolvedValue({
      counts: { final: 0 },
      queuedFinal: false,
    });
    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      dispatchReplyFromConfigMock,
      finalizeInboundContextMock,
      resolveAgentRouteMock,
      storePath: "/tmp/feishu-acp-failure-sessions.json",
      withReplyDispatcherMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("sends one ACP failure notice to the topic root across replay", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      chatId: "oc_group_topic",
      messageId: "om_topic_msg_1",
      rootId: "om_topic_root_1",
      text: "hello topic",
      threadId: "omt_topic_1",
    });

    await expectFeishuSingleEffectAcrossReplay({
      effectMock: sendMessageFeishuMock,
      event,
      handler: onMessage,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-acp",
        replyInThread: true,
        replyToMessageId: "om_topic_root_1",
        text: expect.stringContaining("runtime unavailable"),
        to: "chat:oc_group_topic",
      }),
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });

  it("does not duplicate the ACP failure notice after the first send succeeds", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      chatId: "oc_group_topic",
      messageId: "om_topic_msg_2",
      rootId: "om_topic_root_1",
      text: "hello topic",
      threadId: "omt_topic_1",
    });

    await expectFeishuSingleEffectAcrossReplay({
      effectMock: sendMessageFeishuMock,
      event,
      handler: onMessage,
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(lastRuntime?.error).not.toHaveBeenCalled();
  });
});
