import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./channel-config-shared.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import { qqbotSetupWizard } from "./setup-surface.js";
import type { ResolvedQQBotAccount } from "./types.js";

/**
 * Setup-only QQBot plugin — lightweight subset used during `openclaw onboard`
 * and `openclaw configure` without pulling the full runtime dependencies.
 */
export const qqbotSetupPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  capabilities: {
    blockStreaming: true,
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
  },
  config: {
    ...qqbotConfigAdapter,
  },
  configSchema: qqbotChannelConfigSchema,
  id: "qqbot",
  meta: {
    ...qqbotMeta,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  setup: {
    ...qqbotSetupAdapterShared,
  },
  setupWizard: qqbotSetupWizard,
};
