import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import {
  type ResolvedIMessageAccount,
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "./accounts.js";
import { type ChannelPlugin, getChatChannelMeta } from "./channel-api.js";
import { IMessageChannelConfigSchema } from "./config-schema.js";
import {
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "./media-contract.js";
import { createIMessageSetupWizardProxy } from "./setup-core.js";

export const IMESSAGE_CHANNEL = "imessage" as const;

async function loadIMessageChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const imessageSetupWizard = createIMessageSetupWizardProxy(
  async () => (await loadIMessageChannelRuntime()).imessageSetupWizard,
);

export const imessageConfigAdapter = createScopedChannelConfigAdapter<ResolvedIMessageAccount>({
  clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
  defaultAccountId: resolveDefaultIMessageAccountId,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom),
  listAccountIds: listIMessageAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveIMessageAccount),
  resolveAllowFrom: (account: ResolvedIMessageAccount) => account.config.allowFrom,
  resolveDefaultTo: (account: ResolvedIMessageAccount) => account.config.defaultTo,
  sectionKey: IMESSAGE_CHANNEL,
});

export const imessageSecurityAdapter =
  createRestrictSendersChannelSecurity<ResolvedIMessageAccount>({
    channelKey: IMESSAGE_CHANNEL,
    groupAllowFromPath: "channels.imessage.groupAllowFrom",
    groupPolicyPath: "channels.imessage.groupPolicy",
    mentionGated: false,
    openScope: "any member",
    policyPathSuffix: "dmPolicy",
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    surface: "iMessage groups",
  });

export function createIMessagePluginBase(params: {
  setupWizard?: NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedIMessageAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "reload"
  | "configSchema"
  | "config"
  | "security"
  | "setup"
  | "messaging"
> {
  const base = createChannelPluginBase({
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
    },
    config: {
      ...imessageConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
        }),
      isConfigured: (account) => account.configured,
    },
    configSchema: IMessageChannelConfigSchema,
    id: IMESSAGE_CHANNEL,
    meta: {
      ...getChatChannelMeta(IMESSAGE_CHANNEL),
      aliases: ["imsg"],
      showConfigured: false,
    },
    reload: { configPrefixes: ["channels.imessage"] },
    security: imessageSecurityAdapter,
    setup: params.setup,
    setupWizard: params.setupWizard,
  });
  return {
    ...base,
    messaging: {
      resolveInboundAttachmentRoots: (params) =>
        resolveIMessageAttachmentRoots({ accountId: params.accountId, cfg: params.cfg }),
      resolveRemoteInboundAttachmentRoots: (params) =>
        resolveIMessageRemoteAttachmentRoots({ accountId: params.accountId, cfg: params.cfg }),
    },
  } as Pick<
    ChannelPlugin<ResolvedIMessageAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "reload"
    | "configSchema"
    | "config"
    | "security"
    | "setup"
    | "messaging"
  >;
}
