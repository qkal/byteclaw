import "./lifecycle.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleReplyDispatcher,
  createFeishuTextMessageEvent,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  runFeishuLifecycleSequence,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let handlersByAccount = new Map<string, Record<string, (data: unknown) => Promise<void>>>();
let runtimesByAccount = new Map<string, RuntimeEnv>();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function createLifecycleConfig(): ClawdbotConfig {
  return {
    agents: {
      list: [{ id: "main" }, { id: "susan" }],
    },
    broadcast: {
      oc_broadcast_group: ["susan", "main"],
    },
    channels: {
      feishu: {
        accounts: {
          "account-A": {
            enabled: true,
            appId: "cli_a",
            appSecret: "secret_a", // Pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_broadcast_group: {
                requireMention: false,
              },
            },
          },
          "account-B": {
            enabled: true,
            appId: "cli_b",
            appSecret: "secret_b", // Pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_broadcast_group: {
                requireMention: false,
              },
            },
          },
        },
        enabled: true,
        groupPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
      },
    },
    messages: {
      inbound: {
        byChannel: {
          feishu: 0,
        },
        debounceMs: 0,
      },
    },
  } as ClawdbotConfig;
}

function createLifecycleAccount(accountId: "account-A" | "account-B"): ResolvedFeishuAccount {
  const config: FeishuConfig = FeishuConfigSchema.parse({
    connectionMode: "websocket",
    enabled: true,
    groupPolicy: "open",
    groups: {
      oc_broadcast_group: {
        requireMention: false,
      },
    },
    requireMention: false,
    resolveSenderNames: false,
  });
  return {
    accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: accountId === "account-A" ? "cli_a" : "cli_b",
    appSecret: accountId === "account-A" ? "secret_a" : "secret_b", // Pragma: allowlist secret
    domain: "feishu",
    config,
  };
}

async function setupLifecycleMonitor(accountId: "account-A" | "account-B") {
  const runtime = createNonExitingRuntimeEnv();
  runtimesByAccount.set(accountId, runtime);
  return setupFeishuLifecycleHandler({
    account: createLifecycleAccount(accountId),
    cfg: createLifecycleConfig(),
    createEventDispatcherMock,
    handlerKey: "im.message.receive_v1",
    missingHandlerMessage: `missing im.message.receive_v1 handler for ${accountId}`,
    onRegister: (registered) => {
      handlersByAccount.set(accountId, registered);
    },
    once: true,
    runtime,
  });
}

describe("Feishu broadcast reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    handlersByAccount = new Map();
    runtimesByAccount = new Map();
    setFeishuLifecycleStateDir("openclaw-feishu-broadcast");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockReturnValue(null);
    resolveAgentRouteMock.mockReturnValue({
      accountId: "account-A",
      agentId: "main",
      channel: "feishu",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:feishu:group:oc_broadcast_group",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "broadcast reply once",
      shouldSendFinalReply: (ctx) =>
        typeof (ctx as { SessionKey?: string } | undefined)?.SessionKey === "string" &&
        (ctx as { SessionKey: string }).SessionKey.includes("agent:main:"),
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      dispatchReplyFromConfigMock,
      finalizeInboundContextMock,
      resolveAgentRouteMock,
      storePath: "/tmp/feishu-broadcast-sessions.json",
      withReplyDispatcherMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("uses one active reply path when the same broadcast event reaches two accounts", async () => {
    const onMessageA = await setupLifecycleMonitor("account-A");
    const onMessageB = await setupLifecycleMonitor("account-B");
    const event = createFeishuTextMessageEvent({
      chatId: "oc_broadcast_group",
      messageId: "om_broadcast_once",
      text: "hello broadcast",
    });

    await runFeishuLifecycleSequence(
      [() => onMessageA(event), () => onMessageB(event)],
      [
        () => {
          expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
        },
        () => {
          expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
          expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
        },
      ],
    );

    expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
    expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();

    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-a",
        chatId: "oc_broadcast_group",
        replyToMessageId: "om_broadcast_once",
      }),
    );

    const sessionKeys = finalizeInboundContextMock.mock.calls.map(
      (call) => (call[0] as { SessionKey?: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:main:feishu:group:oc_broadcast_group");
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc_broadcast_group");

    const activeDispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(activeDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate delivery after a post-send failure on the first account", async () => {
    const onMessageA = await setupLifecycleMonitor("account-A");
    const onMessageB = await setupLifecycleMonitor("account-B");
    const event = createFeishuTextMessageEvent({
      chatId: "oc_broadcast_group",
      messageId: "om_broadcast_retry",
      text: "hello broadcast",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      if (typeof ctx?.SessionKey === "string" && ctx.SessionKey.includes("agent:susan:")) {
        return { counts: { final: 0 }, queuedFinal: false };
      }
      await dispatcher.sendFinalReply({ text: "broadcast reply once" });
      throw new Error("post-send failure");
    });

    await runFeishuLifecycleSequence(
      [() => onMessageA(event), () => onMessageB(event)],
      [
        () => {
          expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
        },
        () => {
          expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
        },
      ],
    );

    expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
    expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);

    const activeDispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(activeDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
