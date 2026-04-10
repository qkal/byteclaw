import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type Mock, expect, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import {
  type NativeCommandTestParams as RegisterTelegramNativeCommandsParams,
  createNativeCommandTestParams as createBaseNativeCommandTestParams,
  createTelegramPrivateCommandContext,
} from "./bot-native-commands.fixture-test-support.js";

interface RegisteredCommand {
  command: string;
  description: string;
}
type UnknownMock = Mock<(...args: unknown[]) => unknown>;

interface CreateCommandBotResult {
  bot: RegisterTelegramNativeCommandsParams["bot"];
  commandHandlers: Map<string, (ctx: unknown) => Promise<void>>;
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
}
interface CreateCommandBotParams {
  api?: Record<string, unknown>;
}

const skillCommandMocks = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn<TelegramNativeCommandDeps["listSkillCommandsForAgents"]>(
    () => [],
  ),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
  editMessageTelegram: vi.fn(async () => ({ chatId: "100", messageId: "999", ok: true as const })),
  emitTelegramMessageSentHooks: vi.fn(),
}));

export const {listSkillCommandsForAgents} = skillCommandMocks;
export const {deliverReplies} = deliveryMocks;
export const {editMessageTelegram} = deliveryMocks;
export const {emitTelegramMessageSentHooks} = deliveryMocks;

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
  emitTelegramMessageSentHooks,
}));

vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies,
}));

export async function waitForRegisteredCommands(
  setMyCommands: ReturnType<typeof vi.fn>,
): Promise<RegisteredCommand[]> {
  await vi.waitFor(() => {
    expect(setMyCommands).toHaveBeenCalled();
  });
  return setMyCommands.mock.calls[0]?.[0] as RegisteredCommand[];
}

export function resetNativeCommandMenuMocks() {
  listSkillCommandsForAgents.mockClear();
  listSkillCommandsForAgents.mockReturnValue([]);
  deliverReplies.mockClear();
  deliverReplies.mockResolvedValue({ delivered: true });
  editMessageTelegram.mockClear();
  editMessageTelegram.mockResolvedValue({ chatId: "100", messageId: "999", ok: true as const });
  emitTelegramMessageSentHooks.mockClear();
}

export function createCommandBot(params: CreateCommandBotParams = {}): CreateCommandBotResult {
  const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
  const deleteMessage = vi.fn().mockResolvedValue(true);
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const bot = {
    api: {
      deleteMessage,
      sendMessage,
      setMyCommands,
      ...params.api,
    },
    command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
      commandHandlers.set(name, cb);
    }),
  } as unknown as RegisterTelegramNativeCommandsParams["bot"];
  return { bot, commandHandlers, deleteMessage, sendMessage, setMyCommands };
}

export function createNativeCommandTestParams(
  cfg: OpenClawConfig,
  params: Partial<RegisterTelegramNativeCommandsParams> = {},
): RegisterTelegramNativeCommandsParams {
  const dispatchResult: Awaited<
    ReturnType<TelegramNativeCommandDeps["dispatchReplyWithBufferedBlockDispatcher"]>
  > = {
    counts: { block: 0, final: 0, tool: 0 },
    queuedFinal: false,
  };
  const telegramDeps: TelegramNativeCommandDeps = {
    dispatchReplyWithBufferedBlockDispatcher: vi.fn(
      async () => dispatchResult,
    ) as TelegramNativeCommandDeps["dispatchReplyWithBufferedBlockDispatcher"],
    editMessageTelegram,
    listSkillCommandsForAgents,
    loadConfig: vi.fn(() => cfg) as TelegramNativeCommandDeps["loadConfig"],
    readChannelAllowFromStore: vi.fn(
      async () => [],
    ) as TelegramNativeCommandDeps["readChannelAllowFromStore"],
    syncTelegramMenuCommands: vi.fn(({ bot, commandsToRegister }) => {
      if (commandsToRegister.length === 0) {
        return undefined;
      }
      return bot.api.setMyCommands(commandsToRegister);
    }) as TelegramNativeCommandDeps["syncTelegramMenuCommands"],
  };
  return createBaseNativeCommandTestParams({
    cfg,
    nativeSkillsEnabled: true,
    runtime: params.runtime ?? ({} as RuntimeEnv),
    telegramDeps,
    ...params,
  });
}

export function createPrivateCommandContext(
  params?: Parameters<typeof createTelegramPrivateCommandContext>[0],
) {
  return createTelegramPrivateCommandContext(params);
}
