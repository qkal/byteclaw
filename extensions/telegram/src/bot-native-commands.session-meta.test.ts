import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import {
  type NativeCommandTestParams,
  createDeferred,
  createNativeCommandTestParams,
  createTelegramPrivateCommandContext,
  createTelegramTopicCommandContext,
} from "./bot-native-commands.fixture-test-support.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

type ResolveConfiguredBindingRouteFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveConfiguredBindingRoute;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").ensureConfiguredBindingRouteReady;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("../../../src/auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherParams =
  Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;
type DeliverRepliesParams = Parameters<DeliverRepliesFn>[0];

const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
  counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
  queuedFinal: false,
};

const persistentBindingMocks = vi.hoisted(() => ({
  ensureConfiguredBindingRouteReady: vi.fn<EnsureConfiguredBindingRouteReadyFn>(async () => ({
    ok: true,
  })),
  resolveConfiguredBindingRoute: vi.fn<ResolveConfiguredBindingRouteFn>(({ route }) => ({
    bindingResolution: null,
    route,
  })),
}));
const sessionMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async () => dispatchReplyResult,
  ),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<DeliverRepliesFn>(async () => ({ delivered: true })),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn<
    (ref: unknown) => { bindingId: string; targetSessionKey: string } | null
  >(() => null),
  touch: vi.fn(),
}));
const conversationStoreMocks = vi.hoisted(() => ({
  readChannelAllowFromStore: vi.fn(async () => []),
  upsertChannelPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: persistentBindingMocks.ensureConfiguredBindingRouteReady,
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => sessionBindingMocks.resolveByConversation(ref),
      touch: (bindingId: string, at?: number) => sessionBindingMocks.touch(bindingId, at),
      unbind: vi.fn(),
    }),
    readChannelAllowFromStore: conversationStoreMocks.readChannelAllowFromStore,
    recordInboundSessionMetaSafe: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        agentId: string;
        sessionKey: string;
        ctx: unknown;
        onError?: (error: unknown) => void;
      }) => {
        const storePath = sessionMocks.resolveStorePath(params.cfg.session?.store, {
          agentId: params.agentId,
        });
        try {
          await sessionMocks.recordSessionMetaFromInbound({
            ctx: params.ctx,
            sessionKey: params.sessionKey,
            storePath,
          });
        } catch (error) {
          params.onError?.(error);
        }
      },
    ),
    resolveConfiguredBindingRoute: persistentBindingMocks.resolveConfiguredBindingRoute,
    upsertChannelPairingRequest: conversationStoreMocks.upsertChannelPairingRequest,
  };
});
vi.mock("./bot-native-commands.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-native-commands.runtime.js")>(
    "./bot-native-commands.runtime.js",
  );
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher,
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  };
});
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));
vi.mock("../../../src/plugins/commands.js", () => ({
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));
vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;

type TelegramCommandHandler = (ctx: unknown) => Promise<void>;

function registerAndResolveStatusHandler(params: {
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const { cfg, allowFrom, groupAllowFrom, telegramCfg, resolveTelegramGroupConfig } = params;
  return registerAndResolveCommandHandlerBase({
    allowFrom: allowFrom ?? ["*"],
    cfg,
    commandName: "status",
    groupAllowFrom: groupAllowFrom ?? [],
    resolveTelegramGroupConfig,
    telegramCfg,
    useAccessGroups: true,
  });
}

function registerAndResolveCommandHandlerBase(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom: string[];
  groupAllowFrom: string[];
  useAccessGroups: boolean;
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    telegramCfg,
    resolveTelegramGroupConfig,
  } = params;
  const commandHandlers = new Map<string, TelegramCommandHandler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const telegramDeps: TelegramNativeCommandDeps = {
    dispatchReplyWithBufferedBlockDispatcher:
      replyMocks.dispatchReplyWithBufferedBlockDispatcher as TelegramNativeCommandDeps["dispatchReplyWithBufferedBlockDispatcher"],
    getPluginCommandSpecs: vi.fn(() => []),
    listSkillCommandsForAgents: vi.fn(() => []),
    loadConfig: vi.fn(() => cfg),
    readChannelAllowFromStore: vi.fn(async () => []),
    syncTelegramMenuCommands: vi.fn(),
  };
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({
      allowFrom,
      bot: {
        api: {
          sendMessage,
          setMyCommands: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn((name: string, cb: TelegramCommandHandler) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as NativeCommandTestParams["bot"],
      cfg,
      groupAllowFrom,
      resolveTelegramGroupConfig,
      telegramCfg,
      telegramDeps,
      useAccessGroups,
    }),
  });

  const handler = commandHandlers.get(commandName);
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
}

function registerAndResolveCommandHandler(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    telegramCfg,
    resolveTelegramGroupConfig,
  } = params;
  return registerAndResolveCommandHandlerBase({
    allowFrom: allowFrom ?? [],
    cfg,
    commandName,
    groupAllowFrom: groupAllowFrom ?? [],
    resolveTelegramGroupConfig,
    telegramCfg,
    useAccessGroups: useAccessGroups ?? true,
  });
}

function createConfiguredAcpTopicBinding(boundSessionKey: string) {
  return {
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      boundAt: 0,
      conversation: {
        accountId: "default",
        channel: "telegram",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: boundSessionKey,
    },
    spec: {
      accountId: "default",
      agentId: "codex",
      channel: "telegram",
      conversationId: "-1001234567890:topic:42",
      mode: "persistent",
      parentConversationId: "-1001234567890",
    },
  } as const;
}

function createConfiguredBindingRoute(
  route: ResolvedAgentRoute,
  binding: ReturnType<typeof createConfiguredAcpTopicBinding> | null,
) {
  return {
    bindingResolution: binding
      ? {
          compiledBinding: {
            agentId: binding.spec.agentId,
            binding: {
              acp: {
                mode: binding.spec.mode,
              },
              agentId: binding.spec.agentId,
              match: {
                accountId: binding.spec.accountId,
                channel: "telegram",
                peer: {
                  id: binding.spec.conversationId,
                  kind: "group" as const,
                },
              },
              type: "acp" as const,
            },
            bindingConversationId: binding.spec.conversationId,
            channel: "telegram" as const,
            provider: {
              compileConfiguredBinding: () => ({
                conversationId: binding.spec.conversationId,
                ...(binding.spec.parentConversationId
                  ? { parentConversationId: binding.spec.parentConversationId }
                  : {}),
              }),
              matchInboundConversation: () => ({
                conversationId: binding.spec.conversationId,
                ...(binding.spec.parentConversationId
                  ? { parentConversationId: binding.spec.parentConversationId }
                  : {}),
              }),
            },
            target: {
              conversationId: binding.spec.conversationId,
              ...(binding.spec.parentConversationId
                ? { parentConversationId: binding.spec.parentConversationId }
                : {}),
            },
            targetFactory: {
              driverId: "acp" as const,
              materialize: () => ({
                record: binding.record,
                statefulTarget: {
                  agentId: binding.spec.agentId,
                  driverId: "acp" as const,
                  kind: "stateful" as const,
                  sessionKey: binding.record.targetSessionKey,
                },
              }),
            },
          },
          conversation: binding.record.conversation,
          match: {
            conversationId: binding.spec.conversationId,
            ...(binding.spec.parentConversationId
              ? { parentConversationId: binding.spec.parentConversationId }
              : {}),
          },
          record: binding.record,
          statefulTarget: {
            agentId: binding.spec.agentId,
            driverId: "acp" as const,
            kind: "stateful" as const,
            sessionKey: binding.record.targetSessionKey,
          },
        }
      : null,
    ...(binding ? { boundSessionKey: binding.record.targetSessionKey } : {}),
    route,
  };
}

function expectUnauthorizedNewCommandBlocked(sendMessage: ReturnType<typeof vi.fn>) {
  expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  expect(persistentBindingMocks.resolveConfiguredBindingRoute).not.toHaveBeenCalled();
  expect(persistentBindingMocks.ensureConfiguredBindingRouteReady).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    -1_001_234_567_890,
    "You are not authorized to use this command.",
    expect.objectContaining({ message_thread_id: 42 }),
  );
}

describe("registerTelegramNativeCommands — session metadata", () => {
  beforeAll(async () => {
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    persistentBindingMocks.resolveConfiguredBindingRoute.mockClear();
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(route, null),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockClear();
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });
    sessionMocks.recordSessionMetaFromInbound.mockClear().mockResolvedValue(undefined);
    sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
    replyMocks.dispatchReplyWithBufferedBlockDispatcher
      .mockClear()
      .mockResolvedValue(dispatchReplyResult);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    deliveryMocks.deliverReplies.mockClear().mockResolvedValue({ delivered: true });
  });

  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(createTelegramPrivateCommandContext());

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as [
        { sessionKey?: string; ctx?: { OriginatingChannel?: string; Provider?: string } },
      ][]
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBe("agent:main:telegram:slash:200");
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);

    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(createTelegramPrivateCommandContext());

    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("does not inject approval buttons for native command replies once the monitor owns approvals", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Mode: foreground\nRun: /approve 7f423fdc allow-once (or allow-always / deny).",
          },
          { kind: "final" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              approvers: ["12345"],
              enabled: true,
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0] as
      | DeliverRepliesParams
      | undefined;
    const deliveredPayload = deliveredCall?.replies?.[0];
    expect(deliveredPayload).toBeTruthy();
    expect(deliveredPayload?.["text"]).toContain("/approve 7f423fdc allow-once");
    expect(deliveredPayload?.["channelData"]).toBeUndefined();
  });

  it("suppresses local structured exec approval replies for native commands", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            channelData: {
              execApproval: {
                allowedDecisions: ["allow-once", "allow-always", "deny"],
                approvalId: "7f423fdc-1111-2222-3333-444444444444",
                approvalSlug: "7f423fdc",
              },
            },
            text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
          },
          { kind: "tool" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              approvers: ["12345"],
              enabled: true,
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("sends native command error replies silently when silentErrorReplies is enabled", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver({ isError: true, text: "oops" }, { kind: "final" });
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            silentErrorReplies: true,
          },
        },
      },
      telegramCfg: { silentErrorReplies: true },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0] as
      | DeliverRepliesParams
      | undefined;
    expect(deliveredCall).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ isError: true })],
        silent: true,
      }),
    );
  });

  it("routes Telegram native commands through configured ACP topic bindings", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        {
          ...route,
          agentId: "codex",
          matchedBy: "binding.channel",
          sessionKey: boundSessionKey,
        },
        createConfiguredAcpTopicBinding(boundSessionKey),
      ),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });

    const { handler } = registerAndResolveStatusHandler({
      allowFrom: ["200"],
      cfg: {},
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(persistentBindingMocks.resolveConfiguredBindingRoute).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredBindingRouteReady).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as [
        { ctx?: { CommandTargetSessionKey?: string } },
      ][]
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
    const sessionMetaCall = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as [{ sessionKey?: string }][]
    )[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe("agent:codex:telegram:slash:200");
  });

  it("routes Telegram native commands through topic-specific agent sessions", async () => {
    const { handler } = registerAndResolveStatusHandler({
      allowFrom: ["200"],
      cfg: {},
      groupAllowFrom: ["200"],
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "zu" },
      }),
    });
    await handler(createTelegramTopicCommandContext());

    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as [
        { ctx?: { CommandTargetSessionKey?: string } },
      ][]
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(
      "agent:zu:telegram:group:-1001234567890:topic:42",
    );
  });

  it("routes Telegram native commands through bound topic sessions", async () => {
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "default:-1001234567890:topic:42",
      targetSessionKey: "agent:codex-acp:session-1",
    });

    const { handler } = registerAndResolveStatusHandler({
      allowFrom: ["200"],
      cfg: {},
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith({
      accountId: "default",
      channel: "telegram",
      conversationId: "-1001234567890:topic:42",
    });
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as [
        { ctx?: { CommandTargetSessionKey?: string } },
      ][]
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe("agent:codex-acp:session-1");
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith(
      "default:-1001234567890:topic:42",
      undefined,
    );
  });

  it.each(["new", "reset"] as const)(
    "preserves the topic-qualified origin target for native /%s in forum topics",
    async (commandName) => {
      const { handler } = registerAndResolveCommandHandler({
        allowFrom: ["200"],
        cfg: {},
        commandName,
        groupAllowFrom: ["200"],
        useAccessGroups: true,
      });
      await handler(createTelegramTopicCommandContext());

      const dispatchCall = (
        replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as [
          {
            ctx?: {
              CommandTargetSessionKey?: string;
              MessageThreadId?: number;
              OriginatingTo?: string;
            };
          },
        ][]
      )[0]?.[0];
      expect(dispatchCall?.ctx).toEqual(
        expect.objectContaining({
          CommandTargetSessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
          MessageThreadId: 42,
          OriginatingTo: "telegram:-1001234567890:topic:42",
        }),
      );
    },
  );

  it("aborts native command dispatch when configured ACP topic binding cannot initialize", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        {
          ...route,
          agentId: "codex",
          matchedBy: "binding.channel",
          sessionKey: boundSessionKey,
        },
        createConfiguredAcpTopicBinding(boundSessionKey),
      ),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({
      error: "gateway unavailable",
      ok: false,
    });

    const { handler, sendMessage } = registerAndResolveStatusHandler({
      allowFrom: ["200"],
      cfg: {},
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1_001_234_567_890,
      "Configured ACP binding is unavailable right now. Please try again.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps /new blocked in ACP-bound Telegram topics when sender is unauthorized", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        {
          ...route,
          agentId: "codex",
          matchedBy: "binding.channel",
          sessionKey: boundSessionKey,
        },
        createConfiguredAcpTopicBinding(boundSessionKey),
      ),
    );
    persistentBindingMocks.ensureConfiguredBindingRouteReady.mockResolvedValue({ ok: true });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      allowFrom: [],
      cfg: {},
      commandName: "new",
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });

  it("keeps /new blocked for unbound Telegram topics when sender is unauthorized", async () => {
    persistentBindingMocks.resolveConfiguredBindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(route, null),
    );

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      allowFrom: [],
      cfg: {},
      commandName: "new",
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });
});
