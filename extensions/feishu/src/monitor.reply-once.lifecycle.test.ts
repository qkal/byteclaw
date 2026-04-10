import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { RuntimeEnv } from "../runtime-api.js";
import "./lifecycle.test-support.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  createFeishuTextMessageEvent,
  createResolvedFeishuLifecycleAccount,
  expectFeishuReplyDispatcherSentFinalReplyOnce,
  expectFeishuReplyPipelineDedupedAcrossReplay,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: RuntimeEnv | null = null;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountConfig: {
    groupPolicy: "open",
    groups: {
      oc_group_1: {
        groupSessionScope: "group_topic_sender",
        replyInThread: "enabled",
        requireMention: false,
      },
    },
  },
  accountId: "acct-lifecycle",
  appId: "cli_test",
  appSecret: "secret_test",
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-lifecycle",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    groupPolicy: "open",
    groups: {
      oc_group_1: {
        groupSessionScope: "group_topic_sender",
        replyInThread: "enabled",
        requireMention: false,
      },
    },
  },
});

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

describe("Feishu reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _handlers = {};
    lastRuntime = null;
    setFeishuLifecycleStateDir("openclaw-feishu-lifecycle");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: "agent:bound-agent:feishu:topic:om_root_topic_1:ou_sender_1",
    });

    resolveAgentRouteMock.mockReturnValue({
      accountId: "acct-lifecycle",
      agentId: "main",
      channel: "feishu",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:feishu:group:oc_group_1",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "reply once",
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      dispatchReplyFromConfigMock,
      finalizeInboundContextMock,
      resolveAgentRouteMock,
      storePath: "/tmp/feishu-lifecycle-sessions.json",
      withReplyDispatcherMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("routes a topic-bound inbound event and emits one reply across duplicate replay", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      chatId: "oc_group_1",
      messageId: "om_lifecycle_once",
      rootId: "om_root_topic_1",
      text: "hello from topic",
      threadId: "omt_topic_1",
    });

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      createFeishuReplyDispatcherMock,
      dispatchReplyFromConfigMock,
      event,
      handler: onMessage,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-lifecycle",
        chatId: "oc_group_1",
        replyInThread: true,
        replyToMessageId: "om_root_topic_1",
        rootId: "om_root_topic_1",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-lifecycle",
        MessageSid: "om_lifecycle_once",
        MessageThreadId: "om_root_topic_1",
        SessionKey: "agent:bound-agent:feishu:topic:om_root_topic_1:ou_sender_1",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-1");
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });

  it("does not duplicate delivery when the first attempt fails after sending the reply", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      chatId: "oc_group_1",
      messageId: "om_lifecycle_retry",
      rootId: "om_root_topic_1",
      text: "hello from topic",
      threadId: "omt_topic_1",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      dispatchReplyFromConfigMock,
      event,
      handler: onMessage,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
    });

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });
});
