import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  type ResolvedLineAccount,
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "./channel-api.js";

export function normalizeLineAllowFrom(entry: string): string {
  return entry.replace(/^line:(?:user:)?/i, "");
}

export const lineConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedLineAccount,
  ResolvedLineAccount
>({
  clearBaseFields: ["channelSecret", "tokenFile", "secretFile"],
  defaultAccountId: resolveDefaultLineAccountId,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map(normalizeLineAllowFrom),
  listAccountIds: listLineAccountIds,
  resolveAccount: (cfg, accountId) =>
    resolveLineAccount({ accountId: accountId ?? undefined, cfg }),
  resolveAllowFrom: (account) => account.config.allowFrom,
  sectionKey: "line",
});
