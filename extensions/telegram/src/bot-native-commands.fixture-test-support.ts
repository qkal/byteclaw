import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { OpenClawConfig, TelegramAccountConfig } from "../runtime-api.js";
import type { RegisterTelegramNativeCommandsParams } from "./bot-native-commands.js";

export type NativeCommandTestParams = RegisterTelegramNativeCommandsParams;

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function createNativeCommandTestParams(
  params: Partial<NativeCommandTestParams> = {},
): NativeCommandTestParams {
  const log = vi.fn();
  return {
    accountId: params.accountId ?? "default",
    allowFrom: params.allowFrom ?? [],
    bot:
      params.bot ??
      ({
        api: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          setMyCommands: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as NativeCommandTestParams["bot"]),
    cfg: params.cfg ?? ({} as OpenClawConfig),
    groupAllowFrom: params.groupAllowFrom ?? [],
    nativeDisabledExplicit: params.nativeDisabledExplicit ?? false,
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    opts: params.opts ?? { token: "token" },
    replyToMode: params.replyToMode ?? "off",
    resolveGroupPolicy:
      params.resolveGroupPolicy ??
      (() =>
        ({
          allowed: true,
          allowlistEnabled: false,
        }) as ReturnType<NativeCommandTestParams["resolveGroupPolicy"]>),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      ((_chatId, _messageThreadId) => ({ groupConfig: undefined, topicConfig: undefined })),
    runtime:
      params.runtime ??
      ({
        error: vi.fn(),
        exit: vi.fn(),
        log,
      } as unknown as RuntimeEnv),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
    telegramDeps: params.telegramDeps,
    textLimit: params.textLimit ?? 4000,
    useAccessGroups: params.useAccessGroups ?? false,
  };
}

export function createTelegramPrivateCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      chat: { id: params?.chatId ?? 100, type: "private" as const },
      date: params?.date ?? Math.floor(Date.now() / 1000),
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
      message_id: params?.messageId ?? 1,
    },
  };
}

export function createTelegramTopicCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  threadId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      chat: {
        id: params?.chatId ?? -1_001_234_567_890,
        is_forum: true,
        title: params?.title ?? "OpenClaw",
        type: "supergroup" as const,
      },
      date: params?.date ?? Math.floor(Date.now() / 1000),
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
      message_id: params?.messageId ?? 2,
      message_thread_id: params?.threadId ?? 42,
    },
  };
}
