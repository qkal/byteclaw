import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { getPluginCommandSpecs } from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";

export type TelegramNativeCommandDeps = Pick<
  TelegramBotDeps,
  | "dispatchReplyWithBufferedBlockDispatcher"
  | "editMessageTelegram"
  | "listSkillCommandsForAgents"
  | "loadConfig"
  | "readChannelAllowFromStore"
  | "syncTelegramMenuCommands"
> & {
  getPluginCommandSpecs?: typeof getPluginCommandSpecs;
};

let telegramSendRuntimePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendRuntime() {
  telegramSendRuntimePromise ??= import("./send.js");
  return await telegramSendRuntimePromise;
}

export const defaultTelegramNativeCommandDeps: TelegramNativeCommandDeps = {
  get dispatchReplyWithBufferedBlockDispatcher() {
    return dispatchReplyWithBufferedBlockDispatcher;
  },
  async editMessageTelegram(...args) {
    const { editMessageTelegram } = await loadTelegramSendRuntime();
    return await editMessageTelegram(...args);
  },
  get getPluginCommandSpecs() {
    return getPluginCommandSpecs;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get loadConfig() {
    return loadConfig;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get syncTelegramMenuCommands() {
    return syncTelegramMenuCommands;
  },
};
