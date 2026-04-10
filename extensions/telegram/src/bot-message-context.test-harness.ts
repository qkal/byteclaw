import type { BuildTelegramMessageContextParams, TelegramMediaRef } from "./bot-message-context.js";

export const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: {} },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

interface BuildTelegramMessageContextForTestParams {
  message: Record<string, unknown>;
  allMedia?: TelegramMediaRef[];
  options?: BuildTelegramMessageContextParams["options"];
  cfg?: Record<string, unknown>;
  accountId?: string;
  resolveGroupActivation?: BuildTelegramMessageContextParams["resolveGroupActivation"];
  resolveGroupRequireMention?: BuildTelegramMessageContextParams["resolveGroupRequireMention"];
  resolveTelegramGroupConfig?: BuildTelegramMessageContextParams["resolveTelegramGroupConfig"];
}

export async function buildTelegramMessageContextForTest(
  params: BuildTelegramMessageContextForTestParams,
): Promise<
  Awaited<ReturnType<typeof import("./bot-message-context.js").buildTelegramMessageContext>>
> {
  const { vi } = await loadVitestModule();
  const buildTelegramMessageContext = await loadBuildTelegramMessageContext();
  return await buildTelegramMessageContext({
    account: { accountId: params.accountId ?? "default" } as never,
    ackReactionScope: "off",
    allMedia: params.allMedia ?? [],
    allowFrom: [],
    bot: {
      api: {
        sendChatAction: vi.fn(),
        setMessageReaction: vi.fn(),
      },
    } as never,
    cfg: (params.cfg ?? baseTelegramMessageContextConfig) as never,
    dmPolicy: "open",
    groupAllowFrom: [],
    groupHistories: new Map(),
    historyLimit: 0,
    loadFreshConfig: () => (params.cfg ?? baseTelegramMessageContextConfig) as never,
    logger: { info: vi.fn() },
    options: params.options ?? {},
    primaryCtx: {
      me: { id: 7, username: "bot" },
      message: {
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: 1,
        text: "hello",
        ...params.message,
      },
    } as never,
    resolveGroupActivation: params.resolveGroupActivation ?? (() => undefined),
    resolveGroupRequireMention: params.resolveGroupRequireMention ?? (() => false),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      })),
    sendChatActionHandler: { sendChatAction: vi.fn() } as never,
    storeAllowFrom: [],
  });
}

let buildTelegramMessageContextLoader:
  | typeof import("./bot-message-context.js").buildTelegramMessageContext
  | undefined;
let vitestModuleLoader: Promise<typeof import("vitest")> | undefined;
let messageContextMocksInstalled = false;

async function loadBuildTelegramMessageContext() {
  await installMessageContextTestMocks();
  if (!buildTelegramMessageContextLoader) {
    ({ buildTelegramMessageContext: buildTelegramMessageContextLoader } =
      await import("./bot-message-context.js"));
  }
  return buildTelegramMessageContextLoader;
}

async function loadVitestModule() {
  vitestModuleLoader ??= import("vitest");
  return await vitestModuleLoader;
}

async function installMessageContextTestMocks() {
  if (messageContextMocksInstalled) {
    return;
  }
  messageContextMocksInstalled = true;
}
