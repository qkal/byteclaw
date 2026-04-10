import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import type { ResolvedTelegramAccount } from "./src/accounts.js";
import { resolveTelegramAccount } from "./src/accounts.js";
import { telegramApprovalCapability } from "./src/approval-native.js";
import { telegramConfigAdapter } from "./src/shared.js";

export const telegramCommandTestPlugin = {
  allowlist: buildDmGroupAccountAllowlistAdapter<ResolvedTelegramAccount>({
    channelId: "telegram",
    normalize: ({ cfg, accountId, values }) =>
      telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
    resolveAccount: resolveTelegramAccount,
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
  }),
  approvalCapability: telegramApprovalCapability,
  capabilities: {
    blockStreaming: true,
    chatTypes: ["direct", "group", "channel", "thread"],
    media: true,
    nativeCommands: true,
    polls: true,
    reactions: true,
    threads: true,
  },
  config: telegramConfigAdapter,
  id: "telegram",
  meta: getChatChannelMeta("telegram"),
  pairing: {
    idLabel: "telegramUserId",
  },
} satisfies Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  "id" | "meta" | "capabilities" | "config" | "approvalCapability" | "pairing" | "allowlist"
>;
