import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type GetReplyOptions,
  type MsgContext,
  type ReplyPayload,
  createReplyDispatcher,
  resetInboundDedupe,
} from "openclaw/plugin-sdk/reply-runtime";
import type { MockFn } from "openclaw/plugin-sdk/testing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { beforeEach, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

type AnyMock = ReturnType<typeof vi.fn>;
type AnyAsyncMock = ReturnType<typeof vi.fn>;
type LoadConfigFn = typeof import("openclaw/plugin-sdk/config-runtime").loadConfig;
type LoadSessionStoreFn = typeof import("openclaw/plugin-sdk/config-runtime").loadSessionStore;
type ResolveStorePathFn = typeof import("openclaw/plugin-sdk/config-runtime").resolveStorePath;
type SessionStore = ReturnType<LoadSessionStoreFn>;
type TelegramBotRuntimeForTest = NonNullable<
  Parameters<typeof import("./bot.js").setTelegramBotRuntimeForTest>[0]
>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DispatchReplyHarnessParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];

const _EMPTY_REPLY_COUNTS: DispatchReplyWithBufferedBlockDispatcherResult["counts"] = {
  block: 0,
  final: 0,
  tool: 0,
};

const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}.json`,
}));

const { loadWebMedia } = vi.hoisted((): { loadWebMedia: AnyMock } => ({
  loadWebMedia: vi.fn(),
}));

export function getLoadWebMediaMock(): AnyMock {
  return loadWebMedia;
}

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia,
}));
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia,
}));

const { loadConfig, loadSessionStoreMock, resolveStorePathMock, sessionStoreEntries } = vi.hoisted(
  (): {
    loadConfig: MockFn<LoadConfigFn>;
    loadSessionStoreMock: MockFn<LoadSessionStoreFn>;
    resolveStorePathMock: MockFn<ResolveStorePathFn>;
    sessionStoreEntries: { value: SessionStore };
  } => ({
    loadConfig: vi.fn<LoadConfigFn>(() => ({})),
    loadSessionStoreMock: vi.fn<LoadSessionStoreFn>(
      (_storePath, _opts) => sessionStoreEntries.value,
    ),
    resolveStorePathMock: vi.fn<ResolveStorePathFn>(
      (storePath?: string) => storePath ?? sessionStorePath,
    ),
    sessionStoreEntries: { value: {} as SessionStore },
  }),
);

export function getLoadConfigMock(): AnyMock {
  return loadConfig;
}

export function getLoadSessionStoreMock(): AnyMock {
  return loadSessionStoreMock;
}

export function setSessionStoreEntriesForTest(entries: SessionStore) {
  sessionStoreEntries.value = JSON.parse(JSON.stringify(entries)) as SessionStore;
}

const { readChannelAllowFromStore, upsertChannelPairingRequest } = vi.hoisted(
  (): {
    readChannelAllowFromStore: MockFn<TelegramBotDeps["readChannelAllowFromStore"]>;
    upsertChannelPairingRequest: AnyAsyncMock;
  } => ({
    readChannelAllowFromStore: vi.fn(async () => [] as string[]),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })),
  }),
);

export function getReadChannelAllowFromStoreMock(): AnyAsyncMock {
  return readChannelAllowFromStore;
}

export function getUpsertChannelPairingRequestMock(): AnyAsyncMock {
  return upsertChannelPairingRequest;
}

const skillCommandListHoisted = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));
const modelProviderDataHoisted = vi.hoisted(() => ({
  buildModelsProviderData: vi.fn(),
}));
const replySpyHoisted = vi.hoisted(() => ({
  replySpy: vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  }) as MockFn<
    (
      ctx: MsgContext,
      opts?: GetReplyOptions,
      configOverride?: OpenClawConfig,
    ) => Promise<ReplyPayload | ReplyPayload[] | undefined>
  >,
}));

async function dispatchHarnessReplies(
  params: DispatchReplyHarnessParams,
  runReply: (
    params: DispatchReplyHarnessParams,
  ) => Promise<ReplyPayload | ReplyPayload[] | undefined>,
): Promise<DispatchReplyWithBufferedBlockDispatcherResult> {
  await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
  const reply = await runReply(params);
  const payloads: ReplyPayload[] =
    reply === undefined ? [] : (Array.isArray(reply) ? reply : [reply]);
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, info) => {
      await params.dispatcherOptions.deliver?.(payload, info);
    },
    onError: (err, info) => {
      params.dispatcherOptions.onError?.(err, info);
    },
    onHeartbeatStrip: params.dispatcherOptions.onHeartbeatStrip,
    onSkip: (payload, info) => {
      params.dispatcherOptions.onSkip?.(payload, info);
    },
    responsePrefix: params.dispatcherOptions.responsePrefix,
    responsePrefixContext: params.dispatcherOptions.responsePrefixContext,
    responsePrefixContextProvider: params.dispatcherOptions.responsePrefixContextProvider,
  });
  let finalCount = 0;
  for (const payload of payloads) {
    if (dispatcher.sendFinalReply(payload)) {
      finalCount += 1;
    }
  }
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  return {
    counts: {
      block: 0,
      final: finalCount,
      tool: 0,
    },
    queuedFinal: finalCount > 0,
  };
}

const dispatchReplyHoisted = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async (params: DispatchReplyHarnessParams) =>
      await dispatchHarnessReplies(params, async (dispatchParams) => await replySpyHoisted.replySpy(dispatchParams.ctx, dispatchParams.replyOptions)),
  ),
}));
export const {listSkillCommandsForAgents} = skillCommandListHoisted;
const {buildModelsProviderData} = modelProviderDataHoisted;
export const {replySpy} = replySpyHoisted;
export const {dispatchReplyWithBufferedBlockDispatcher} = dispatchReplyHoisted;
const menuSyncHoisted = vi.hoisted(() => ({
  syncTelegramMenuCommands: vi.fn(async ({ bot, commandsToRegister }) => {
    await bot.api.setMyCommands(commandsToRegister);
  }),
}));
export const {syncTelegramMenuCommands} = menuSyncHoisted;

function parseModelRef(raw: string): { provider?: string; model: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      model: trimmed.slice(slashIndex + 1),
      provider: trimmed.slice(0, slashIndex),
    };
  }
  return { model: trimmed };
}

function createModelsProviderDataFromConfig(cfg: OpenClawConfig): {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
} {
  const byProvider = new Map<string, Set<string>>();
  const add = (providerRaw: string | undefined, modelRaw: string | undefined) => {
    const provider = normalizeLowercaseStringOrEmpty(providerRaw);
    const model = modelRaw?.trim();
    if (!provider || !model) {
      return;
    }
    const existing = byProvider.get(provider) ?? new Set<string>();
    existing.add(model);
    byProvider.set(provider, existing);
  };

  const resolvedDefault = resolveDefaultModelForAgent({ cfg });
  add(resolvedDefault.provider, resolvedDefault.model);

  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseModelRef(raw);
    add(parsed.provider ?? resolvedDefault.provider, parsed.model);
  }

  const providers = [...byProvider.keys()].toSorted();
  return { byProvider, modelNames: new Map<string, string>(), providers, resolvedDefault };
}

const systemEventsHoisted = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn<TelegramBotDeps["enqueueSystemEvent"]>(() => false),
}));
export const {enqueueSystemEventSpy} = systemEventsHoisted;
const execApprovalHoisted = vi.hoisted(() => ({
  resolveExecApprovalSpy: vi.fn(async () => undefined),
}));
export const {resolveExecApprovalSpy} = execApprovalHoisted;

const sentMessageCacheHoisted = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
export const {wasSentByBot} = sentMessageCacheHoisted;

vi.doMock("./sent-message-cache.js", () => ({
  clearSentMessageCache: vi.fn(),
  recordSentMessage: vi.fn(),
  wasSentByBot: sentMessageCacheHoisted.wasSentByBot,
}));

// All spy variables used inside vi.mock("grammy", ...) must be created via
// Vi.hoisted() so they are available when the hoisted factory runs, regardless
// Of module evaluation order across different test files.
const grammySpies = vi.hoisted(() => ({
  answerCallbackQuerySpy: vi.fn(async () => undefined) as AnyAsyncMock,
  botCtorSpy: vi.fn((_: string, __?: { client?: { fetch?: typeof fetch } }) => undefined),
  commandSpy: vi.fn(),
  editMessageReplyMarkupSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  editMessageTextSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  getChatSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  getFileSpy: vi.fn(async () => ({ file_path: "media/file.jpg" })) as AnyAsyncMock,
  getMeSpy: vi.fn(async () => ({
    has_topics_enabled: true,
    username: "openclaw_bot",
  })) as AnyAsyncMock,
  middlewareUseSpy: vi.fn(),
  onSpy: vi.fn(),
  sendAnimationSpy: vi.fn(async () => ({ message_id: 78 })) as AnyAsyncMock,
  sendChatActionSpy: vi.fn(),
  sendMessageDraftSpy: vi.fn(async () => true) as AnyAsyncMock,
  sendMessageSpy: vi.fn(async () => ({ message_id: 77 })) as AnyAsyncMock,
  sendPhotoSpy: vi.fn(async () => ({ message_id: 79 })) as AnyAsyncMock,
  setMessageReactionSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  setMyCommandsSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  stopSpy: vi.fn(),
  useSpy: vi.fn() as MockFn<(arg: unknown) => void>,
}));

export const {useSpy} = grammySpies;
export const {middlewareUseSpy} = grammySpies;
export const {onSpy} = grammySpies;
export const {stopSpy} = grammySpies;
export const {commandSpy} = grammySpies;
export const {botCtorSpy} = grammySpies;
export const {answerCallbackQuerySpy} = grammySpies;
export const {sendChatActionSpy} = grammySpies;
export const {editMessageTextSpy} = grammySpies;
export const {editMessageReplyMarkupSpy} = grammySpies;
export const {sendMessageDraftSpy} = grammySpies;
export const {setMessageReactionSpy} = grammySpies;
export const {setMyCommandsSpy} = grammySpies;
export const {getMeSpy} = grammySpies;
export const {getChatSpy} = grammySpies;
export const {sendMessageSpy} = grammySpies;
export const {sendAnimationSpy} = grammySpies;
export const {sendPhotoSpy} = grammySpies;
export const {getFileSpy} = grammySpies;

const runnerHoisted = vi.hoisted(() => ({
  sequentializeMiddleware: vi.fn(async (_ctx: unknown, next?: () => Promise<void>) => {
    if (typeof next === "function") {
      await next();
    }
  }),
  sequentializeSpy: vi.fn(() => runnerHoisted.sequentializeMiddleware),
  throttlerSpy: vi.fn(() => "throttler"),
}));
export const {sequentializeSpy} = runnerHoisted;
export let sequentializeKey: ((ctx: unknown) => string) | undefined;
export const {throttlerSpy} = runnerHoisted;
export const telegramBotRuntimeForTest: TelegramBotRuntimeForTest = {
  Bot: class {
    api = {
      answerCallbackQuery: grammySpies.answerCallbackQuerySpy,
      config: { use: grammySpies.useSpy },
      editMessageReplyMarkup: grammySpies.editMessageReplyMarkupSpy,
      editMessageText: grammySpies.editMessageTextSpy,
      getChat: grammySpies.getChatSpy,
      getFile: grammySpies.getFileSpy,
      getMe: grammySpies.getMeSpy,
      sendAnimation: grammySpies.sendAnimationSpy,
      sendChatAction: grammySpies.sendChatActionSpy,
      sendMessage: grammySpies.sendMessageSpy,
      sendMessageDraft: grammySpies.sendMessageDraftSpy,
      sendPhoto: grammySpies.sendPhotoSpy,
      setMessageReaction: grammySpies.setMessageReactionSpy,
      setMyCommands: grammySpies.setMyCommandsSpy,
    };
    use = grammySpies.middlewareUseSpy;
    on = grammySpies.onSpy;
    stop = grammySpies.stopSpy;
    command = grammySpies.commandSpy;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      (grammySpies.botCtorSpy as unknown as (token: string, options?: unknown) => void)(
        token,
        options,
      );
    }
  } as unknown as TelegramBotRuntimeForTest["Bot"],
  apiThrottler: (() =>
    (
      runnerHoisted.throttlerSpy as unknown as () => unknown
    )()) as unknown as TelegramBotRuntimeForTest["apiThrottler"],
  sequentialize: ((keyFn: (ctx: unknown) => string) => {
    sequentializeKey = keyFn;
    return (
      runnerHoisted.sequentializeSpy as unknown as () => ReturnType<
        TelegramBotRuntimeForTest["sequentialize"]
      >
    )();
  }) as unknown as TelegramBotRuntimeForTest["sequentialize"],
};
export const telegramBotDepsForTest: TelegramBotDeps = {
  buildModelsProviderData: buildModelsProviderData as TelegramBotDeps["buildModelsProviderData"],
  dispatchReplyWithBufferedBlockDispatcher,
  enqueueSystemEvent: enqueueSystemEventSpy as TelegramBotDeps["enqueueSystemEvent"],
  listSkillCommandsForAgents:
    listSkillCommandsForAgents as TelegramBotDeps["listSkillCommandsForAgents"],
  loadConfig,
  loadSessionStore: loadSessionStoreMock as TelegramBotDeps["loadSessionStore"],
  loadWebMedia: loadWebMedia as TelegramBotDeps["loadWebMedia"],
  readChannelAllowFromStore:
    readChannelAllowFromStore as TelegramBotDeps["readChannelAllowFromStore"],
  resolveExecApproval: resolveExecApprovalSpy as NonNullable<
    TelegramBotDeps["resolveExecApproval"]
  >,
  resolveStorePath: resolveStorePathMock,
  syncTelegramMenuCommands: syncTelegramMenuCommands as TelegramBotDeps["syncTelegramMenuCommands"],
  upsertChannelPairingRequest:
    upsertChannelPairingRequest as TelegramBotDeps["upsertChannelPairingRequest"],
  wasSentByBot: wasSentByBot as TelegramBotDeps["wasSentByBot"],
};

vi.doMock("./bot.runtime.js", () => telegramBotRuntimeForTest);

export const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) {
    throw new Error(`Missing handler for event: ${event}`);
  }
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

const DEFAULT_TELEGRAM_TEST_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      envelopeTimezone: "utc",
    },
  },
  channels: {
    telegram: { allowFrom: ["*"], dmPolicy: "open" },
  },
};

export function makeTelegramMessageCtx(params: {
  chat: {
    id: number;
    type: string;
    title?: string;
    is_forum?: boolean;
  };
  from: { id: number; username?: string };
  text: string;
  date?: number;
  messageId?: number;
  messageThreadId?: number;
}) {
  return {
    getFile: async () => ({ download: async () => new Uint8Array() }),
    me: { username: "openclaw_bot" },
    message: {
      chat: params.chat,
      date: params.date ?? 1_736_380_800,
      from: params.from,
      message_id: params.messageId ?? 42,
      text: params.text,
      ...(params.messageThreadId === undefined
        ? {}
        : { message_thread_id: params.messageThreadId }),
    },
  };
}

export function makeForumGroupMessageCtx(params?: {
  chatId?: number;
  threadId?: number;
  text?: string;
  fromId?: number;
  username?: string;
  title?: string;
}) {
  return makeTelegramMessageCtx({
    chat: {
      id: params?.chatId ?? -1_001_234_567_890,
      is_forum: true,
      title: params?.title ?? "Forum Group",
      type: "supergroup",
    },
    from: { id: params?.fromId ?? 12_345, username: params?.username ?? "testuser" },
    messageThreadId: params?.threadId,
    text: params?.text ?? "hello",
  });
}

beforeEach(() => {
  resetInboundDedupe();
  loadConfig.mockReset();
  loadConfig.mockReturnValue(DEFAULT_TELEGRAM_TEST_CONFIG);
  sessionStoreEntries.value = {};
  loadSessionStoreMock.mockReset();
  loadSessionStoreMock.mockImplementation(() => sessionStoreEntries.value);
  resolveStorePathMock.mockReset();
  resolveStorePathMock.mockImplementation((storePath?: string) => storePath ?? sessionStorePath);
  loadWebMedia.mockReset();
  readChannelAllowFromStore.mockReset();
  readChannelAllowFromStore.mockResolvedValue([]);
  upsertChannelPairingRequest.mockReset();
  upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRCODE", created: true } as const);
  onSpy.mockReset();
  commandSpy.mockReset();
  stopSpy.mockReset();
  useSpy.mockReset();
  replySpy.mockReset();
  replySpy.mockImplementation(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  resolveExecApprovalSpy.mockReset();
  resolveExecApprovalSpy.mockResolvedValue(undefined);
  dispatchReplyWithBufferedBlockDispatcher.mockReset();
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
    async (params: DispatchReplyHarnessParams) =>
      await dispatchHarnessReplies(params, async (dispatchParams) => await replySpy(dispatchParams.ctx, dispatchParams.replyOptions)),
  );
  syncTelegramMenuCommands.mockReset();
  syncTelegramMenuCommands.mockImplementation(async ({ bot, commandsToRegister }) => {
    await bot.api.setMyCommands(commandsToRegister);
  });

  sendAnimationSpy.mockReset();
  sendAnimationSpy.mockResolvedValue({ message_id: 78 });
  sendPhotoSpy.mockReset();
  sendPhotoSpy.mockResolvedValue({ message_id: 79 });
  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue({ message_id: 77 });
  getFileSpy.mockReset();
  getFileSpy.mockResolvedValue({ file_path: "media/file.jpg" });

  setMessageReactionSpy.mockReset();
  setMessageReactionSpy.mockResolvedValue(undefined);
  answerCallbackQuerySpy.mockReset();
  answerCallbackQuerySpy.mockResolvedValue(undefined);
  sendChatActionSpy.mockReset();
  sendChatActionSpy.mockResolvedValue(undefined);
  setMyCommandsSpy.mockReset();
  setMyCommandsSpy.mockResolvedValue(undefined);
  getChatSpy.mockReset();
  getChatSpy.mockResolvedValue(undefined);
  getMeSpy.mockReset();
  getMeSpy.mockResolvedValue({
    has_topics_enabled: true,
    username: "openclaw_bot",
  });
  editMessageTextSpy.mockReset();
  editMessageTextSpy.mockResolvedValue({ message_id: 88 });
  editMessageReplyMarkupSpy.mockReset();
  editMessageReplyMarkupSpy.mockResolvedValue({ message_id: 88 });
  sendMessageDraftSpy.mockReset();
  sendMessageDraftSpy.mockResolvedValue(true);
  enqueueSystemEventSpy.mockReset();
  wasSentByBot.mockReset();
  wasSentByBot.mockReturnValue(false);
  listSkillCommandsForAgents.mockReset();
  listSkillCommandsForAgents.mockReturnValue([]);
  buildModelsProviderData.mockReset();
  buildModelsProviderData.mockImplementation(async (cfg: OpenClawConfig) => createModelsProviderDataFromConfig(cfg));
  middlewareUseSpy.mockReset();
  runnerHoisted.sequentializeMiddleware.mockReset();
  runnerHoisted.sequentializeMiddleware.mockImplementation(async (_ctx, next) => {
    if (typeof next === "function") {
      await next();
    }
  });
  sequentializeSpy.mockReset();
  sequentializeSpy.mockImplementation(() => runnerHoisted.sequentializeMiddleware);
  botCtorSpy.mockReset();
  sequentializeKey = undefined;
});
