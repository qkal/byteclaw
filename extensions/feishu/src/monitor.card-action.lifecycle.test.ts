import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { RuntimeEnv } from "../runtime-api.js";
import "./lifecycle.test-support.js";
import { resetProcessedFeishuCardActionTokensForTests } from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
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
  sendCardFeishuMock,
  sendMessageFeishuMock,
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: RuntimeEnv | null = null;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountConfig: {
    dmPolicy: "open",
  },
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    dmPolicy: "open",
  },
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    dmPolicy: "open",
  },
});

function createCardActionEvent(params: {
  token: string;
  action: string;
  command: string;
  chatId?: string;
  chatType?: "group" | "p2p";
}) {
  const openId = "ou_user1";
  const chatId = params.chatId ?? "p2p:ou_user1";
  const chatType = params.chatType ?? "p2p";
  return {
    action: {
      tag: "button",
      value: createFeishuCardInteractionEnvelope({
        a: params.action,
        c: {
          e: Date.now() + 60_000,
          h: chatId,
          t: chatType,
          u: openId,
        },
        k: "quick",
        q: params.command,
      }),
    },
    context: {
      chat_id: chatId,
      open_id: openId,
      user_id: "user_1",
    },
    operator: {
      open_id: openId,
      union_id: "union_1",
      user_id: "user_1",
    },
    token: params.token,
  };
}

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuLifecycleHandler({
    account: lifecycleAccount,
    cfg: lifecycleConfig,
    createEventDispatcherMock,
    handlerKey: "card.action.trigger",
    missingHandlerMessage: "missing card.action.trigger handler",
    onRegister: (registered) => {
      _handlers = registered;
    },
    runtime: lastRuntime,
  });
}

describe("Feishu card-action lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _handlers = {};
    lastRuntime = null;
    resetProcessedFeishuCardActionTokensForTests();
    setFeishuLifecycleStateDir("openclaw-feishu-card-action");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-card",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    resolveAgentRouteMock.mockReturnValue({
      accountId: "acct-card",
      agentId: "main",
      channel: "feishu",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:feishu:direct:ou_user1",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "card action reply once",
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      dispatchReplyFromConfigMock,
      finalizeInboundContextMock,
      resolveAgentRouteMock,
      storePath: "/tmp/feishu-card-action-sessions.json",
      withReplyDispatcherMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetProcessedFeishuCardActionTokensForTests();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("routes one reply across duplicate callback delivery", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      action: "feishu.quick_actions.help",
      command: "/help",
      token: "tok-card-once",
    });

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      createFeishuReplyDispatcherMock,
      dispatchReplyFromConfigMock,
      event,
      handler: onCardAction,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "p2p:ou_user1",
        replyToMessageId: "card-action-tok-card-once",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-card",
        MessageSid: "card-action-tok-card-once",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not duplicate delivery when retrying after a post-send failure", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      action: "feishu.quick_actions.help",
      command: "/help",
      token: "tok-card-retry",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "card action reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      dispatchReplyFromConfigMock,
      event,
      handler: onCardAction,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
    });

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });
});
