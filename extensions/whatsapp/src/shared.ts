import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { createChannelPluginBase, getChatChannelMeta } from "openclaw/plugin-sdk/core";
import {
  type ChannelSetupWizard,
  createDelegatedSetupWizardProxy,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  type ResolvedWhatsAppAccount,
  hasAnyWhatsAppAuth,
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
} from "./accounts.js";
import { formatWhatsAppConfigAllowFromEntries } from "./config-accessors.js";
import { WhatsAppChannelConfigSchema } from "./config-schema.js";
import { whatsappDoctor } from "./doctor.js";
import { resolveLegacyGroupSessionKey } from "./group-session-contract.js";
import {
  collectUnsupportedSecretRefConfigCandidates,
  unsupportedSecretRefSurfacePatterns,
} from "./security-contract.js";
import { applyWhatsAppSecurityConfigFixes } from "./security-fix.js";
import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./session-contract.js";

export const WHATSAPP_CHANNEL = "whatsapp" as const;

export async function loadWhatsAppChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const whatsappSetupWizardProxy = createWhatsAppSetupWizardProxy(
  async () => (await loadWhatsAppChannelRuntime()).whatsappSetupWizard,
);

const whatsappConfigAdapter = createScopedChannelConfigAdapter<ResolvedWhatsAppAccount>({
  allowTopLevel: false,
  clearBaseFields: [],
  defaultAccountId: resolveDefaultWhatsAppAccountId,
  formatAllowFrom: (allowFrom) => formatWhatsAppConfigAllowFromEntries(allowFrom),
  listAccountIds: listWhatsAppAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveWhatsAppAccount),
  resolveAllowFrom: (account) => account.allowFrom,
  resolveDefaultTo: (account) => account.defaultTo,
  sectionKey: WHATSAPP_CHANNEL,
});

const whatsappResolveDmPolicy = createScopedDmSecurityResolver<ResolvedWhatsAppAccount>({
  channelKey: WHATSAPP_CHANNEL,
  normalizeEntry: (raw) => normalizeE164(raw),
  policyPathSuffix: "dmPolicy",
  resolveAllowFrom: (account) => account.allowFrom,
  resolvePolicy: (account) => account.dmPolicy,
});

export function createWhatsAppSetupWizardProxy(
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
  return createDelegatedSetupWizardProxy({
    channel: WHATSAPP_CHANNEL,
    credentials: [],
    delegateFinalize: true,
    disable: (cfg) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        whatsapp: {
          ...cfg.channels?.whatsapp,
          enabled: false,
        },
      },
    }),
    loadWizard,
    onAccountRecorded: (accountId, options) => {
      options?.onAccountId?.(WHATSAPP_CHANNEL, accountId);
    },
    resolveShouldPromptAccountIds: (params) => Boolean(params.shouldPromptAccountIds),
    status: {
      configuredHint: "linked",
      configuredLabel: "linked",
      configuredScore: 5,
      unconfiguredHint: "not linked",
      unconfiguredLabel: "not linked",
      unconfiguredScore: 4,
    },
  });
}

export function createWhatsAppPluginBase(params: {
  groups: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["groups"]>;
  setupWizard: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["setup"]>;
  isConfigured: NonNullable<ChannelPlugin<ResolvedWhatsAppAccount>["config"]>["isConfigured"];
}) {
  const collectWhatsAppSecurityWarnings =
    createAllowlistProviderRouteAllowlistWarningCollector<ResolvedWhatsAppAccount>({
      noRouteAllowlist: {
        groupAllowFromPath: "channels.whatsapp.groupAllowFrom",
        groupPolicyPath: "channels.whatsapp.groupPolicy",
        routeAllowlistPath: "channels.whatsapp.groups",
        routeScope: "group",
        surface: "WhatsApp groups",
      },
      providerConfigPresent: (cfg) => cfg.channels?.whatsapp !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      resolveRouteAllowlistConfigured: (account) =>
        Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0,
      restrictSenders: {
        groupAllowFromPath: "channels.whatsapp.groupAllowFrom",
        groupPolicyPath: "channels.whatsapp.groupPolicy",
        openScope: "any member in allowed groups",
        surface: "WhatsApp groups",
      },
    });
  const base = createChannelPluginBase({
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      polls: true,
      reactions: true,
    },
    config: {
      ...whatsappConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: Boolean(account.authDir),
          extra: {
            allowFrom: account.allowFrom,
            dmPolicy: account.dmPolicy,
            linked: Boolean(account.authDir),
          },
        }),
      disabledReason: () => "disabled",
      hasPersistedAuthState: ({ cfg }) => hasAnyWhatsAppAuth(cfg),
      isConfigured: params.isConfigured,
      isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
      unconfiguredReason: () => "not linked",
    },
    configSchema: WhatsAppChannelConfigSchema,
    doctor: whatsappDoctor,
    gatewayMethods: ["web.login.start", "web.login.wait"],
    groups: params.groups,
    id: WHATSAPP_CHANNEL,
    meta: {
      ...getChatChannelMeta(WHATSAPP_CHANNEL),
      forceAccountBinding: true,
      preferSessionLookupForAnnounceTarget: true,
      quickstartAllowFrom: true,
      showConfigured: false,
    },
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
    security: {
      applyConfigFixes: applyWhatsAppSecurityConfigFixes,
      collectWarnings: collectWhatsAppSecurityWarnings,
      resolveDmPolicy: whatsappResolveDmPolicy,
    },
    setup: params.setup,
    setupWizard: params.setupWizard,
  });
  return {
    ...base,
    capabilities: base.capabilities!,
    config: base.config!,
    configSchema: base.configSchema!,
    gatewayMethods: base.gatewayMethods!,
    groups: base.groups!,
    messaging: {
      canonicalizeLegacySessionKey: (params) =>
        canonicalizeLegacySessionKey({ agentId: params.agentId, key: params.key }),
      defaultMarkdownTableMode: "bullets",
      isLegacyGroupSessionKey,
      resolveLegacyGroupSessionKey,
    },
    reload: base.reload!,
    secrets: {
      collectUnsupportedSecretRefConfigCandidates,
      unsupportedSecretRefSurfacePatterns,
    },
    security: base.security!,
    setupWizard: base.setupWizard!,
  } satisfies Pick<
    ChannelPlugin<ResolvedWhatsAppAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "reload"
    | "gatewayMethods"
    | "configSchema"
    | "config"
    | "messaging"
    | "secrets"
    | "security"
    | "doctor"
    | "setup"
    | "groups"
  >;
}
