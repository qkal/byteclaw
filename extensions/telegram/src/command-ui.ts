import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  type ProviderInfo,
  buildBrowseProvidersButton,
  buildModelsKeyboard,
  buildProviderKeyboard,
} from "./model-buttons.js";

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): { text: string; callback_data: string }[][] {
  const buttons: { text: string; callback_data: string }[] = [];
  const suffix = agentId ? `:${agentId}` : "";

  if (currentPage > 1) {
    buttons.push({
      callback_data: `commands_page_${currentPage - 1}${suffix}`,
      text: "◀ Prev",
    });
  }

  buttons.push({
    callback_data: `commands_page_noop${suffix}`,
    text: `${currentPage}/${totalPages}`,
  });

  if (currentPage < totalPages) {
    buttons.push({
      callback_data: `commands_page_${currentPage + 1}${suffix}`,
      text: "Next ▶",
    });
  }

  return [buttons];
}

export function buildTelegramCommandsListChannelData(params: {
  currentPage: number;
  totalPages: number;
  agentId?: string;
}): ReplyPayload["channelData"] | null {
  if (params.totalPages <= 1) {
    return null;
  }
  return {
    telegram: {
      buttons: buildCommandsPaginationKeyboard(
        params.currentPage,
        params.totalPages,
        params.agentId,
      ),
    },
  };
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  return {
    telegram: {
      buttons: buildProviderKeyboard(params.providers),
    },
  };
}

export function buildTelegramModelsListChannelData(params: {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
}): ReplyPayload["channelData"] | null {
  return {
    telegram: {
      buttons: buildModelsKeyboard(params),
    },
  };
}

export function buildTelegramModelBrowseChannelData(): ReplyPayload["channelData"] {
  return {
    telegram: {
      buttons: buildBrowseProvidersButton(),
    },
  };
}
