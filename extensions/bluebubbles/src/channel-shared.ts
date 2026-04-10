import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  type ResolvedBlueBubblesAccount,
  listBlueBubblesAccountIds,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { BlueBubblesChannelConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { normalizeBlueBubblesHandle } from "./targets.js";

export const bluebubblesMeta = {
  aliases: ["bb"],
  blurb: "iMessage via the BlueBubbles mac app + REST API.",
  detailLabel: "BlueBubbles",
  docsLabel: "bluebubbles",
  docsPath: "/channels/bluebubbles",
  id: "bluebubbles",
  label: "BlueBubbles",
  order: 75,
  preferOver: ["imessage"],
  selectionLabel: "BlueBubbles (macOS app)",
  systemImage: "bubble.left.and.text.bubble.right",
};

export const bluebubblesCapabilities: ChannelPlugin<ResolvedBlueBubblesAccount>["capabilities"] = {
  chatTypes: ["direct", "group"],
  edit: true,
  effects: true,
  groupManagement: true,
  media: true,
  reactions: true,
  reply: true,
  unsend: true,
};

export const bluebubblesReload = { configPrefixes: ["channels.bluebubbles"] };
export const bluebubblesConfigSchema = BlueBubblesChannelConfigSchema;

export const bluebubblesConfigAdapter =
  createScopedChannelConfigAdapter<ResolvedBlueBubblesAccount>({
    clearBaseFields: ["serverUrl", "password", "name", "webhookPath"],
    defaultAccountId: resolveDefaultBlueBubblesAccountId,
    formatAllowFrom: (allowFrom) =>
      formatNormalizedAllowFromEntries({
        allowFrom,
        normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
      }),
    listAccountIds: listBlueBubblesAccountIds,
    resolveAccount: adaptScopedAccountAccessor(resolveBlueBubblesAccount),
    resolveAllowFrom: (account: ResolvedBlueBubblesAccount) => account.config.allowFrom,
    sectionKey: "bluebubbles",
  });

export function describeBlueBubblesAccount(account: ResolvedBlueBubblesAccount) {
  return describeWebhookAccountSnapshot({
    account,
    configured: account.configured,
    extra: {
      baseUrl: account.baseUrl,
    },
  });
}
