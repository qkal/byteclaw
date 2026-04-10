import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
} from "../../test/helpers/channels/interactive-contract.js";
import type {
  SlackInteractiveHandlerContext,
  SlackInteractiveHandlerRegistration,
} from "../../test/helpers/channels/interactive-contract.js";
import type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "../../test/helpers/channels/interactive-contract.js";
import * as conversationBinding from "./conversation-binding.js";
import { createInteractiveConversationBindingHelpers } from "./interactive-binding-helpers.js";
import {
  clearPluginInteractiveHandlers,
  dispatchPluginInteractiveHandler,
  registerPluginInteractiveHandler,
} from "./interactive.js";

let requestPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.requestPluginConversationBinding
>;
let detachPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.detachPluginConversationBinding
>;
let getCurrentPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.getCurrentPluginConversationBinding
>;

type InteractiveDispatchParams =
  | {
      channel: "telegram";
      data: string;
      dedupeId: string;
      onMatched?: () => Promise<void> | void;
      ctx: Omit<
        TelegramInteractiveHandlerContext,
        | "callback"
        | "respond"
        | "channel"
        | "requestConversationBinding"
        | "detachConversationBinding"
        | "getCurrentConversationBinding"
      > & {
        callbackMessage: {
          messageId: number;
          chatId: string;
          messageText?: string;
        };
      };
      respond: TelegramInteractiveHandlerContext["respond"];
    }
  | {
      channel: "discord";
      data: string;
      dedupeId: string;
      onMatched?: () => Promise<void> | void;
      ctx: Omit<
        DiscordInteractiveHandlerContext,
        | "interaction"
        | "respond"
        | "channel"
        | "requestConversationBinding"
        | "detachConversationBinding"
        | "getCurrentConversationBinding"
      > & {
        interaction: Omit<
          DiscordInteractiveHandlerContext["interaction"],
          "data" | "namespace" | "payload"
        >;
      };
      respond: DiscordInteractiveHandlerContext["respond"];
    }
  | {
      channel: "slack";
      data: string;
      dedupeId: string;
      onMatched?: () => Promise<void> | void;
      ctx: Omit<
        SlackInteractiveHandlerContext,
        | "interaction"
        | "respond"
        | "channel"
        | "requestConversationBinding"
        | "detachConversationBinding"
        | "getCurrentConversationBinding"
      > & {
        interaction: Omit<
          SlackInteractiveHandlerContext["interaction"],
          "data" | "namespace" | "payload"
        >;
      };
      respond: SlackInteractiveHandlerContext["respond"];
    };

type InteractiveModule = typeof import("./interactive.js");

const interactiveModuleUrl = new URL("interactive.ts", import.meta.url).href;

async function importInteractiveModule(cacheBust: string): Promise<InteractiveModule> {
  return (await import(`${interactiveModuleUrl}?t=${cacheBust}`)) as InteractiveModule;
}

function createTelegramDispatchParams(params: {
  data: string;
  callbackId: string;
}): Extract<InteractiveDispatchParams, { channel: "telegram" }> {
  return {
    channel: "telegram",
    ctx: {
      accountId: "default",
      auth: { isAuthorizedSender: true },
      callbackId: params.callbackId,
      callbackMessage: {
        chatId: "-10099",
        messageId: 55,
        messageText: "Pick a thread",
      },
      conversationId: "-10099:topic:77",
      isForum: true,
      isGroup: true,
      parentConversationId: "-10099",
      senderId: "user-1",
      senderUsername: "ada",
      threadId: 77,
    },
    data: params.data,
    dedupeId: params.callbackId,
    respond: {
      clearButtons: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => {}),
      editButtons: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    },
  };
}

function createDiscordDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<
    Extract<InteractiveDispatchParams, { channel: "discord" }>["ctx"]["interaction"]
  >;
}): Extract<InteractiveDispatchParams, { channel: "discord" }> {
  return {
    channel: "discord",
    ctx: {
      accountId: "default",
      auth: { isAuthorizedSender: true },
      conversationId: "channel-1",
      guildId: "guild-1",
      interaction: {
        kind: "button",
        messageId: "message-1",
        values: ["allow"],
        ...params.interaction,
      },
      interactionId: params.interactionId,
      parentConversationId: "parent-1",
      senderId: "user-1",
      senderUsername: "ada",
    },
    data: params.data,
    dedupeId: params.interactionId,
    respond: {
      acknowledge: vi.fn(async () => {}),
      clearComponents: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    },
  };
}

function createSlackDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<
    Extract<InteractiveDispatchParams, { channel: "slack" }>["ctx"]["interaction"]
  >;
}): Extract<InteractiveDispatchParams, { channel: "slack" }> {
  return {
    channel: "slack",
    ctx: {
      accountId: "default",
      auth: { isAuthorizedSender: true },
      conversationId: "C123",
      interaction: {
        actionId: "codex",
        blockId: "codex_actions",
        kind: "button",
        messageTs: "1710000000.000200",
        responseUrl: "https://hooks.slack.test/response",
        selectedLabels: ["Approve"],
        selectedValues: ["approve:thread-1"],
        threadTs: "1710000000.000100",
        triggerId: "trigger-1",
        value: "approve:thread-1",
        ...params.interaction,
      },
      interactionId: params.interactionId,
      parentConversationId: "C123",
      senderId: "user-1",
      senderUsername: "ada",
      threadId: "1710000000.000100",
    },
    data: params.data,
    dedupeId: params.interactionId,
    respond: {
      acknowledge: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    },
  };
}

async function expectDedupedInteractiveDispatch(params: {
  baseParams: InteractiveDispatchParams;
  handler: ReturnType<typeof vi.fn>;
  expectedCall: unknown;
}) {
  const first = await dispatchInteractive(params.baseParams);
  const duplicate = await dispatchInteractive(params.baseParams);

  expect(first).toEqual({ duplicate: false, handled: true, matched: true });
  expect(duplicate).toEqual({ duplicate: true, handled: true, matched: true });
  expect(params.handler).toHaveBeenCalledTimes(1);
  expect(params.handler).toHaveBeenCalledWith(expect.objectContaining(params.expectedCall));
}

async function dispatchInteractive(params: InteractiveDispatchParams) {
  return await dispatchInteractiveWith({ dispatchPluginInteractiveHandler }, params);
}

async function dispatchInteractiveWith(
  interactiveModule: Pick<typeof import("./interactive.js"), "dispatchPluginInteractiveHandler">,
  params: InteractiveDispatchParams,
) {
  if (params.channel === "telegram") {
    return await interactiveModule.dispatchPluginInteractiveHandler<TelegramInteractiveHandlerRegistration>(
      {
        channel: "telegram",
        data: params.data,
        dedupeId: params.dedupeId,
        invoke: ({ registration, namespace, payload }) => {
          const { callbackMessage, ...handlerContext } = params.ctx;
          return registration.handler({
            ...handlerContext,
            callback: {
              chatId: callbackMessage.chatId,
              data: params.data,
              messageId: callbackMessage.messageId,
              messageText: callbackMessage.messageText,
              namespace,
              payload,
            },
            channel: "telegram",
            respond: params.respond,
            ...createInteractiveConversationBindingHelpers({
              conversation: {
                accountId: handlerContext.accountId,
                channel: "telegram",
                conversationId: handlerContext.conversationId,
                parentConversationId: handlerContext.parentConversationId,
                threadId: handlerContext.threadId,
              },
              registration,
              senderId: handlerContext.senderId,
            }),
          });
        },
        onMatched: params.onMatched,
      },
    );
  }
  if (params.channel === "discord") {
    return await interactiveModule.dispatchPluginInteractiveHandler<DiscordInteractiveHandlerRegistration>(
      {
        channel: "discord",
        data: params.data,
        dedupeId: params.dedupeId,
        invoke: ({ registration, namespace, payload }) =>
          registration.handler({
            ...params.ctx,
            channel: "discord",
            interaction: {
              ...params.ctx.interaction,
              data: params.data,
              namespace,
              payload,
            },
            respond: params.respond,
            ...createInteractiveConversationBindingHelpers({
              conversation: {
                accountId: params.ctx.accountId,
                channel: "discord",
                conversationId: params.ctx.conversationId,
                parentConversationId: params.ctx.parentConversationId,
              },
              registration,
              senderId: params.ctx.senderId,
            }),
          }),
        onMatched: params.onMatched,
      },
    );
  }
  return await interactiveModule.dispatchPluginInteractiveHandler<SlackInteractiveHandlerRegistration>(
    {
      channel: "slack",
      data: params.data,
      dedupeId: params.dedupeId,
      invoke: ({ registration, namespace, payload }) =>
        registration.handler({
          ...params.ctx,
          channel: "slack",
          interaction: {
            ...params.ctx.interaction,
            data: params.data,
            namespace,
            payload,
          },
          respond: params.respond,
          ...createInteractiveConversationBindingHelpers({
            conversation: {
              accountId: params.ctx.accountId,
              channel: "slack",
              conversationId: params.ctx.conversationId,
              parentConversationId: params.ctx.parentConversationId,
              threadId: params.ctx.threadId,
            },
            registration,
            senderId: params.ctx.senderId,
          }),
        }),
      onMatched: params.onMatched,
    },
  );
}

function registerInteractiveHandler(params: {
  channel: "telegram" | "discord" | "slack";
  namespace: string;
  handler: ReturnType<typeof vi.fn>;
}) {
  return registerPluginInteractiveHandler("codex-plugin", {
    channel: params.channel,
    handler: params.handler as never,
    namespace: params.namespace,
  });
}

interface BindingHelperCase {
  name: string;
  registerParams: { channel: "telegram" | "discord" | "slack"; namespace: string };
  dispatchParams: InteractiveDispatchParams;
  requestResult: {
    status: "bound";
    binding: {
      bindingId: string;
      pluginId: string;
      pluginName: string;
      pluginRoot: string;
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
      threadId?: string | number;
      boundAt: number;
    };
  };
  requestSummary: string;
  expectedConversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
  };
}

async function expectBindingHelperWiring(params: BindingHelperCase) {
  const currentBinding = {
    ...params.requestResult.binding,
    boundAt: params.requestResult.binding.boundAt + 1,
  };
  requestPluginConversationBindingMock.mockResolvedValueOnce(params.requestResult);
  getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);

  const handler = vi.fn(async (ctx) => {
    await expect(
      ctx.requestConversationBinding({ summary: params.requestSummary }),
    ).resolves.toEqual(params.requestResult);
    await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
    await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
    return { handled: true };
  });

  expect(
    registerPluginInteractiveHandler(
      "codex-plugin",
      {
        ...params.registerParams,
        handler: handler as never,
      },
      { pluginName: "Codex", pluginRoot: "/plugins/codex" },
    ),
  ).toEqual({ ok: true });

  await expect(dispatchInteractive(params.dispatchParams)).resolves.toEqual({
    duplicate: false,
    handled: true,
    matched: true,
  });

  expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
    binding: {
      summary: params.requestSummary,
    },
    conversation: params.expectedConversation,
    pluginId: "codex-plugin",
    pluginName: "Codex",
    pluginRoot: "/plugins/codex",
    requestedBySenderId: "user-1",
  });
  expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
    conversation: params.expectedConversation,
    pluginRoot: "/plugins/codex",
  });
  expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
    conversation: params.expectedConversation,
    pluginRoot: "/plugins/codex",
  });
}

describe("plugin interactive handlers", () => {
  beforeEach(() => {
    clearPluginInteractiveHandlers();
    requestPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "requestPluginConversationBinding")
      .mockResolvedValue({
        binding: {
          accountId: "default",
          bindingId: "binding-1",
          boundAt: 1,
          channel: "telegram",
          conversationId: "-10099:topic:77",
          parentConversationId: "-10099",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          threadId: 77,
        },
        status: "bound",
      });
    detachPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "detachPluginConversationBinding")
      .mockResolvedValue({ removed: true });
    getCurrentPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "getCurrentPluginConversationBinding")
      .mockResolvedValue({
        accountId: "default",
        bindingId: "binding-1",
        boundAt: 1,
        channel: "telegram",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        threadId: 77,
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      baseParams: createTelegramDispatchParams({
        callbackId: "cb-1",
        data: "codex:resume:thread-1",
      }),
      channel: "telegram" as const,
      expectedCall: {
        callback: expect.objectContaining({
          chatId: "-10099",
          messageId: 55,
          namespace: "codex",
          payload: "resume:thread-1",
        }),
        channel: "telegram",
        conversationId: "-10099:topic:77",
      },
      name: "routes Telegram callbacks by namespace and dedupes callback ids",
    },
    {
      baseParams: createDiscordDispatchParams({
        data: "codex:approve:thread-1",
        interaction: { kind: "button", values: ["allow"] },
        interactionId: "ix-1",
      }),
      channel: "discord" as const,
      expectedCall: {
        channel: "discord",
        conversationId: "channel-1",
        interaction: expect.objectContaining({
          messageId: "message-1",
          namespace: "codex",
          payload: "approve:thread-1",
          values: ["allow"],
        }),
      },
      name: "routes Discord interactions by namespace and dedupes interaction ids",
    },
    {
      baseParams: createSlackDispatchParams({
        data: "codex:approve:thread-1",
        interaction: { kind: "button" },
        interactionId: "slack-ix-1",
      }),
      channel: "slack" as const,
      expectedCall: {
        channel: "slack",
        conversationId: "C123",
        interaction: expect.objectContaining({
          actionId: "codex",
          messageTs: "1710000000.000200",
          namespace: "codex",
          payload: "approve:thread-1",
        }),
        threadId: "1710000000.000100",
      },
      name: "routes Slack interactions by namespace and dedupes interaction ids",
    },
  ] as const)("$name", async ({ channel, baseParams, expectedCall }) => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(registerInteractiveHandler({ channel, handler, namespace: "codex" })).toEqual({
      ok: true,
    });

    await expectDedupedInteractiveDispatch({
      baseParams,
      expectedCall,
      handler,
    });
  });

  it("shares interactive handlers across duplicate module instances", async () => {
    const first = await importInteractiveModule(`first-${Date.now()}`);
    const second = await importInteractiveModule(`second-${Date.now()}`);
    const handler = vi.fn(async () => ({ handled: true }));

    first.clearPluginInteractiveHandlers();

    expect(
      first.registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        handler,
        namespace: "codexapp",
      }),
    ).toEqual({ ok: true });

    await expect(
      dispatchInteractiveWith(
        second,
        createTelegramDispatchParams({
          callbackId: "cb-shared-1",
          data: "codexapp:resume:thread-1",
        }),
      ),
    ).resolves.toEqual({ duplicate: false, handled: true, matched: true });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        callback: expect.objectContaining({
          namespace: "codexapp",
          payload: "resume:thread-1",
        }),
        channel: "telegram",
      }),
    );

    second.clearPluginInteractiveHandlers();
  });

  it("rejects duplicate namespace registrations", () => {
    const first = registerPluginInteractiveHandler("plugin-a", {
      channel: "telegram",
      handler: async () => ({ handled: true }),
      namespace: "codex",
    });
    const second = registerPluginInteractiveHandler("plugin-b", {
      channel: "telegram",
      handler: async () => ({ handled: true }),
      namespace: "codex",
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      error: 'Interactive handler namespace "codex" already registered by plugin "plugin-a"',
      ok: false,
    });
  });

  it("preserves arbitrary plugin-owned channel ids", () => {
    const result = registerPluginInteractiveHandler("plugin-a", {
      channel: "msteams",
      handler: async () => ({ handled: true }),
      namespace: "codex",
    });

    expect(result).toEqual({ ok: true });
  });

  it("acknowledges matched Discord interactions before awaiting plugin handlers", async () => {
    const callOrder: string[] = [];
    const handler = vi.fn(async () => {
      callOrder.push("handler");
      expect(callOrder).toEqual(["ack", "handler"]);
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "discord",
        handler,
        namespace: "codex",
      }),
    ).toEqual({ ok: true });

    await expect(
      dispatchInteractive({
        ...createDiscordDispatchParams({
          data: "codex:approve:thread-1",
          interaction: { kind: "button", values: undefined },
          interactionId: "ix-ack-1",
        }),
        onMatched: async () => {
          callOrder.push("ack");
        },
      }),
    ).resolves.toEqual({
      duplicate: false,
      handled: true,
      matched: true,
    });
  });

  it.each([
    {
      dispatchParams: createTelegramDispatchParams({
        callbackId: "cb-bind",
        data: "codex:bind",
      }),
      expectedConversation: {
        accountId: "default",
        channel: "telegram",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
      name: "wires Telegram conversation binding helpers with topic context",
      registerParams: { channel: "telegram", namespace: "codex" },
      requestResult: {
        binding: {
          accountId: "default",
          bindingId: "binding-telegram",
          boundAt: 1,
          channel: "telegram",
          conversationId: "-10099:topic:77",
          parentConversationId: "-10099",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          threadId: 77,
        },
        status: "bound" as const,
      },
      requestSummary: "Bind this topic",
    },
    {
      dispatchParams: createDiscordDispatchParams({
        data: "codex:bind",
        interaction: { kind: "button", values: ["allow"] },
        interactionId: "ix-bind",
      }),
      expectedConversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
      name: "wires Discord conversation binding helpers with parent channel context",
      registerParams: { channel: "discord", namespace: "codex" },
      requestResult: {
        binding: {
          accountId: "default",
          bindingId: "binding-discord",
          boundAt: 1,
          channel: "discord",
          conversationId: "channel-1",
          parentConversationId: "parent-1",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
        },
        status: "bound" as const,
      },
      requestSummary: "Bind Discord",
    },
    {
      dispatchParams: createSlackDispatchParams({
        data: "codex:bind",
        interaction: {
          kind: "button",
          selectedLabels: ["Bind"],
          selectedValues: ["bind"],
          value: "bind",
        },
        interactionId: "slack-bind",
      }),
      expectedConversation: {
        accountId: "default",
        channel: "slack",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
      name: "wires Slack conversation binding helpers with thread context",
      registerParams: { channel: "slack", namespace: "codex" },
      requestResult: {
        binding: {
          accountId: "default",
          bindingId: "binding-slack",
          boundAt: 1,
          channel: "slack",
          conversationId: "C123",
          parentConversationId: "C123",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          threadId: "1710000000.000100",
        },
        status: "bound" as const,
      },
      requestSummary: "Bind Slack",
    },
  ] as const)("$name", async (testCase) => {
    await expectBindingHelperWiring(testCase);
  });

  it("does not consume dedupe keys when a handler throws", async () => {
    const handler = vi
      .fn(async () => ({ handled: true }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ handled: true });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        handler,
        namespace: "codex",
      }),
    ).toEqual({ ok: true });

    const baseParams = createTelegramDispatchParams({
      callbackId: "cb-throw",
      data: "codex:resume:thread-1",
    });

    await expect(dispatchInteractive(baseParams)).rejects.toThrow("boom");
    await expect(dispatchInteractive(baseParams)).resolves.toEqual({
      duplicate: false,
      handled: true,
      matched: true,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
