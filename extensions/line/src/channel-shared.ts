import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { hasLineCredentials, parseLineAllowFromId } from "./account-helpers.js";
import {
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedLineAccount,
  resolveLineAccount,
} from "./channel-api.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { LineChannelConfigSchema } from "./config-schema.js";

export const lineChannelMeta = {
  blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
  detailLabel: "LINE Bot",
  docsLabel: "line",
  docsPath: "/channels/line",
  id: "line",
  label: "LINE",
  selectionLabel: "LINE (Messaging API)",
  systemImage: "message.fill",
} as const;

export const lineChannelPluginCommon = {
  capabilities: {
    blockStreaming: true,
    chatTypes: ["direct", "group"],
    media: true,
    nativeCommands: false,
    reactions: false,
    threads: false,
  },
  config: {
    ...lineConfigAdapter,
    describeAccount: (account: ResolvedLineAccount) =>
      describeWebhookAccountSnapshot({
        account,
        configured: hasLineCredentials(account),
        extra: {
          tokenSource: account.tokenSource ?? undefined,
        },
      }),
    isConfigured: (account: ResolvedLineAccount) => hasLineCredentials(account),
  },
  configSchema: LineChannelConfigSchema,
  meta: {
    ...lineChannelMeta,
    quickstartAllowFrom: true,
  },
  reload: { configPrefixes: ["channels.line"] },
} satisfies Pick<
  ChannelPlugin<ResolvedLineAccount>,
  "meta" | "capabilities" | "reload" | "configSchema" | "config"
>;

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasLineCredentials(resolveLineAccount({ accountId, cfg }));
}

export { parseLineAllowFromId };
