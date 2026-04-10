import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedMattermostAccount,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
} from "./mattermost/accounts.js";

export const mattermostMeta = {
  blurb: "self-hosted Slack-style chat; install the plugin to enable.",
  detailLabel: "Mattermost Bot",
  docsLabel: "mattermost",
  docsPath: "/channels/mattermost",
  id: "mattermost",
  label: "Mattermost",
  order: 65,
  quickstartAllowFrom: true,
  selectionLabel: "Mattermost (plugin)",
  systemImage: "bubble.left.and.bubble.right",
} as const;

export function normalizeMattermostAllowEntry(entry: string): string {
  return normalizeLowercaseStringOrEmpty(
    entry
      .trim()
      .replace(/^(mattermost|user):/i, "")
      .replace(/^@/, ""),
  );
}

export function formatMattermostAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${normalizeLowercaseStringOrEmpty(username)}` : "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^(mattermost|user):/i, ""));
}

export const mattermostConfigAdapter = createScopedChannelConfigAdapter<ResolvedMattermostAccount>({
  clearBaseFields: ["botToken", "baseUrl", "name"],
  defaultAccountId: resolveDefaultMattermostAccountId,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatMattermostAllowEntry,
    }),
  listAccountIds: listMattermostAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMattermostAccount),
  resolveAllowFrom: (account) => account.config.allowFrom,
  sectionKey: "mattermost",
});

export function isMattermostConfigured(account: ResolvedMattermostAccount): boolean {
  return Boolean(account.botToken && account.baseUrl);
}

export function describeMattermostAccount(account: ResolvedMattermostAccount) {
  return describeAccountSnapshot({
    account,
    configured: isMattermostConfigured(account),
    extra: {
      baseUrl: account.baseUrl,
      botTokenSource: account.botTokenSource,
    },
  });
}
