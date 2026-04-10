import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPluginBase, getChatChannelMeta } from "openclaw/plugin-sdk/core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  normalizeE164,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedSignalAccount,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
import { SignalChannelConfigSchema } from "./config-schema.js";
import { createSignalSetupWizardProxy } from "./setup-core.js";

export const SIGNAL_CHANNEL = "signal" as const;

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const signalSetupWizard = createSignalSetupWizardProxy(
  async () => (await loadSignalChannelRuntime()).signalSetupWizard,
);

export const signalConfigAdapter = createScopedChannelConfigAdapter<ResolvedSignalAccount>({
  clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
  defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => normalizeStringifiedOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
      .filter(Boolean),
  listAccountIds: (cfg) => listSignalAccountIds(cfg),
  resolveAccount: adaptScopedAccountAccessor((params) => resolveSignalAccount(params)),
  resolveAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
  resolveDefaultTo: (account: ResolvedSignalAccount) => account.config.defaultTo,
  sectionKey: SIGNAL_CHANNEL,
});

export const signalSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedSignalAccount>({
  channelKey: SIGNAL_CHANNEL,
  groupAllowFromPath: "channels.signal.groupAllowFrom",
  groupPolicyPath: "channels.signal.groupPolicy",
  mentionGated: false,
  normalizeDmEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
  openScope: "any member",
  policyPathSuffix: "dmPolicy",
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "Signal groups",
});

export function createSignalPluginBase(params: {
  setupWizard?: NonNullable<ChannelPlugin<ResolvedSignalAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedSignalAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedSignalAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "streaming"
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
      reactions: true,
    },
    config: {
      ...signalConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
      isConfigured: (account) => account.configured,
    },
    configSchema: SignalChannelConfigSchema,
    id: SIGNAL_CHANNEL,
    meta: {
      ...getChatChannelMeta(SIGNAL_CHANNEL),
    },
    reload: { configPrefixes: ["channels.signal"] },
    security: signalSecurityAdapter,
    setup: params.setup,
    setupWizard: params.setupWizard,
    streaming: {
      blockStreamingCoalesceDefaults: { idleMs: 1000, minChars: 1500 },
    },
  });
  return {
    ...base,
    messaging: {
      defaultMarkdownTableMode: "bullets",
    },
  } as Pick<
    ChannelPlugin<ResolvedSignalAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "streaming"
    | "reload"
    | "configSchema"
    | "config"
    | "security"
    | "setup"
    | "messaging"
  >;
}
