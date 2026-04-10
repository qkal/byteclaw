import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { createInspectedDirectoryEntriesLister } from "openclaw/plugin-sdk/directory-runtime";
import { type InspectedTelegramAccount, inspectTelegramAccount } from "./account-inspect.js";

export const listTelegramDirectoryPeersFromConfig =
  createInspectedDirectoryEntriesLister<InspectedTelegramAccount>({
    inspectAccount: (cfg, accountId) =>
      inspectTelegramAccount({ accountId, cfg }) as InspectedTelegramAccount | null,
    kind: "user",
    normalizeId: (entry) => {
      const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    },
    resolveSources: (account) => [
      mapAllowFromEntries(account.config.allowFrom),
      Object.keys(account.config.dms ?? {}),
    ],
  });

export const listTelegramDirectoryGroupsFromConfig =
  createInspectedDirectoryEntriesLister<InspectedTelegramAccount>({
    inspectAccount: (cfg, accountId) =>
      inspectTelegramAccount({ accountId, cfg }) as InspectedTelegramAccount | null,
    kind: "group",
    normalizeId: (entry) => entry.trim() || null,
    resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
  });
