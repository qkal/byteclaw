import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";
import { createNativeCommandTestParams } from "./bot-native-commands.fixture-test-support.js";
import type { RegisterTelegramNativeCommandsParams } from "./bot-native-commands.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

type GetPluginCommandSpecsFn =
  typeof import("./bot-native-commands.runtime.js").getPluginCommandSpecs;
type MatchPluginCommandFn = typeof import("./bot-native-commands.runtime.js").matchPluginCommand;
type ExecutePluginCommandFn =
  typeof import("./bot-native-commands.runtime.js").executePluginCommand;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type RecordInboundSessionMetaSafeFn =
  typeof import("./bot-native-commands.runtime.js").recordInboundSessionMetaSafe;
type ResolveChunkModeFn = typeof import("./bot-native-commands.runtime.js").resolveChunkMode;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("./bot-native-commands.runtime.js").ensureConfiguredBindingRouteReady;
type GetAgentScopedMediaLocalRootsFn =
  typeof import("./bot-native-commands.runtime.js").getAgentScopedMediaLocalRoots;
type CreateChannelReplyPipelineFn =
  typeof import("./bot-native-commands.delivery.runtime.js").createChannelReplyPipeline;
type AnyMock = MockFn<(...args: unknown[]) => unknown>;
type AnyAsyncMock = MockFn<(...args: unknown[]) => Promise<unknown>>;
interface NativeCommandHarness {
  handlers: Record<string, (ctx: unknown) => Promise<void>>;
  sendMessage: AnyAsyncMock;
  setMyCommands: AnyAsyncMock;
  log: AnyMock;
  bot: RegisterTelegramNativeCommandsParams["bot"];
}

const pluginCommandMocks = vi.hoisted(() => ({
  executePluginCommand: vi.fn<ExecutePluginCommandFn>(async () => ({ text: "ok" })),
  getPluginCommandSpecs: vi.fn<GetPluginCommandSpecsFn>(() => []),
  matchPluginCommand: vi.fn<MatchPluginCommandFn>(() => null),
}));
export const {getPluginCommandSpecs} = pluginCommandMocks;
export const {matchPluginCommand} = pluginCommandMocks;
export const {executePluginCommand} = pluginCommandMocks;

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  executePluginCommand: pluginCommandMocks.executePluginCommand,
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
}));

const replyPipelineMocks = vi.hoisted(() => {
  const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
    counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
    queuedFinal: false,
  };
  return {
    createChannelReplyPipeline: vi.fn((() => ({
      onModelSelected: () => {},
      responsePrefixContextProvider: () => undefined,
    })) as unknown as CreateChannelReplyPipelineFn),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn(
      (async () => dispatchReplyResult) as DispatchReplyWithBufferedBlockDispatcherFn,
    ),
    ensureConfiguredBindingRouteReady: vi.fn((async () => ({
      ok: true,
    })) as unknown as EnsureConfiguredBindingRouteReadyFn),
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
    getAgentScopedMediaLocalRoots: vi.fn<GetAgentScopedMediaLocalRootsFn>(() => []),
    recordInboundSessionMetaSafe: vi.fn<RecordInboundSessionMetaSafeFn>(async () => undefined),
    resolveChunkMode: vi.fn((() => "length") as unknown as ResolveChunkModeFn),
  };
});
export const {dispatchReplyWithBufferedBlockDispatcher} = replyPipelineMocks;

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => {}),
}));
export const {deliverReplies} = deliveryMocks;

vi.mock("./bot-native-commands.runtime.js", () => ({
  ensureConfiguredBindingRouteReady: replyPipelineMocks.ensureConfiguredBindingRouteReady,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
  finalizeInboundContext: replyPipelineMocks.finalizeInboundContext,
  getAgentScopedMediaLocalRoots: replyPipelineMocks.getAgentScopedMediaLocalRoots,
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  recordInboundSessionMetaSafe: replyPipelineMocks.recordInboundSessionMetaSafe,
  resolveChunkMode: replyPipelineMocks.resolveChunkMode,
}));
vi.mock("./bot-native-commands.delivery.runtime.js", () => ({
  createChannelReplyPipeline: replyPipelineMocks.createChannelReplyPipeline,
  deliverReplies: deliveryMocks.deliverReplies,
  emitTelegramMessageSentHooks: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  dispatchReplyWithBufferedBlockDispatcher:
    replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  getSessionBindingService: vi.fn(() => ({
    resolveByConversation: vi.fn(() => null),
    touch: vi.fn(),
  })),
  isPluginOwnedSessionBindingRecord: vi.fn(() => false),
  readChannelAllowFromStore: vi.fn(async () => []),
  resolveConfiguredBindingRoute: vi.fn(({ route }: { route: unknown }) => ({
    bindingResolution: null,
    boundSessionKey: "",
    route,
  })),
}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
vi.mock("./bot/delivery.replies.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
export { createNativeCommandTestParams };

export function createNativeCommandsHarness(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  nativeEnabled?: boolean;
  groupConfig?: Record<string, unknown>;
  resolveGroupPolicy?: () => ChannelGroupPolicy;
}): NativeCommandHarness {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage: AnyAsyncMock = vi.fn(async () => undefined);
  const setMyCommands: AnyAsyncMock = vi.fn(async () => undefined);
  const log: AnyMock = vi.fn();
  const telegramDeps = {
    dispatchReplyWithBufferedBlockDispatcher:
      replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
    getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
    listSkillCommandsForAgents: vi.fn(() => []),
    loadConfig: vi.fn(() => params?.cfg ?? ({} as OpenClawConfig)),
    readChannelAllowFromStore: vi.fn(async () => []),
    syncTelegramMenuCommands: vi.fn(),
  };
  const bot = {
    api: {
      sendMessage,
      setMyCommands,
    },
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as RegisterTelegramNativeCommandsParams["bot"];

  registerTelegramNativeCommands({
    accountId: "default",
    allowFrom: params?.allowFrom ?? [],
    bot,
    cfg: params?.cfg ?? ({} as OpenClawConfig),
    groupAllowFrom: params?.groupAllowFrom ?? [],
    nativeDisabledExplicit: false,
    nativeEnabled: params?.nativeEnabled ?? true,
    nativeSkillsEnabled: false,
    opts: { token: "token" },
    replyToMode: "off",
    resolveGroupPolicy:
      params?.resolveGroupPolicy ??
      (() =>
        ({
          allowed: true,
          allowlistEnabled: false,
        }) as ChannelGroupPolicy),
    resolveTelegramGroupConfig: () => ({
      groupConfig: params?.groupConfig as undefined,
      topicConfig: undefined,
    }),
    runtime: params?.runtime ?? ({ log } as unknown as RuntimeEnv),
    shouldSkipUpdate: () => false,
    telegramCfg: params?.telegramCfg ?? ({} as TelegramAccountConfig),
    telegramDeps,
    textLimit: 4000,
    useAccessGroups: params?.useAccessGroups ?? false,
  });

  return { bot, handlers, log, sendMessage, setMyCommands };
}

export function createTelegramGroupCommandContext(params?: {
  senderId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    match: "",
    message: {
      chat: { id: -100_999, is_forum: true, type: "supergroup" },
      date: 1_700_000_000,
      from: {
        id: params?.senderId ?? 12_345,
        username: params?.username ?? "testuser",
      },
      message_id: 1,
      message_thread_id: params?.threadId ?? 42,
    },
  };
}

export function findNotAuthorizedCalls(sendMessage: AnyAsyncMock) {
  return sendMessage.mock.calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
  );
}
