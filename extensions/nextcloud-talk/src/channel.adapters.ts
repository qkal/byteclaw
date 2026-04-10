import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedNextcloudTalkAccount,
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedNextcloudTalkAccount,
  ResolvedNextcloudTalkAccount,
  CoreConfig
>({
  clearBaseFields: ["botSecret", "botSecretFile", "baseUrl", "name"],
  defaultAccountId: resolveDefaultNextcloudTalkAccountId,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({
      allowFrom,
      stripPrefixRe: /^(nextcloud-talk|nc-talk|nc):/i,
    }),
  listAccountIds: listNextcloudTalkAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
  resolveAllowFrom: (account) => account.config.allowFrom,
  sectionKey: "nextcloud-talk",
});

export const nextcloudTalkSecurityAdapter = {
  resolveDmPolicy: createScopedDmSecurityResolver<ResolvedNextcloudTalkAccount>({
    channelKey: "nextcloud-talk",
    normalizeEntry: (raw) =>
      normalizeLowercaseStringOrEmpty(raw.trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, "")),
    policyPathSuffix: "dmPolicy",
    resolveAllowFrom: (account) => account.config.allowFrom,
    resolvePolicy: (account) => account.config.dmPolicy,
  }),
};

export const nextcloudTalkPairingTextAdapter = {
  idLabel: "nextcloudUserId",
  message: "OpenClaw: your access has been approved.",
  normalizeAllowEntry: createPairingPrefixStripper(/^(nextcloud-talk|nc-talk|nc):/i, (entry) =>
    normalizeLowercaseStringOrEmpty(entry),
  ),
};
