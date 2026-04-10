import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  composeAccountWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  type ResolvedIrcAccount,
  listIrcAccountIds,
  resolveDefaultIrcAccountId,
  resolveIrcAccount,
} from "./accounts.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  buildBaseChannelStatusSummary,
} from "./channel-api.js";
import { IrcChannelConfigSchema } from "./config-schema.js";
import { collectIrcMutableAllowlistWarnings } from "./doctor.js";
import { startIrcGatewayAccount } from "./gateway.js";
import {
  isChannelTarget,
  looksLikeIrcTargetId,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
} from "./normalize.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";
import { probeIrc } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { ircSetupAdapter } from "./setup-core.js";
import { ircSetupWizard } from "./setup-surface.js";
import type { CoreConfig, IrcProbe } from "./types.js";

const meta = {
  blurb: "classic IRC networks; host, nick, channels.",
  detailLabel: "IRC",
  docsLabel: "irc",
  docsPath: "/channels/irc",
  id: "irc",
  label: "IRC",
  markdownCapable: true,
  order: 80,
  selectionLabel: "IRC (Server + Nick)",
  systemImage: "number",
};

type IrcChannelRuntimeModule = typeof import("./channel-runtime.js");

let ircChannelRuntimePromise: Promise<IrcChannelRuntimeModule> | undefined;

async function loadIrcChannelRuntime(): Promise<IrcChannelRuntimeModule> {
  ircChannelRuntimePromise ??= import("./channel-runtime.js");
  return await ircChannelRuntimePromise;
}

function normalizePairingTarget(raw: string): string {
  const normalized = normalizeIrcAllowEntry(raw);
  if (!normalized) {
    return "";
  }
  return normalized.split(/[!@]/, 1)[0]?.trim() ?? "";
}

const listIrcDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<ResolvedIrcAccount>({
  kind: "user",
  normalizeId: (entry) => normalizePairingTarget(entry) || null,
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveSources: (account) => [
    account.config.allowFrom ?? [],
    account.config.groupAllowFrom ?? [],
    ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
  ],
});

const listIrcDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<ResolvedIrcAccount>({
  kind: "group",
  normalizeId: (entry) => {
    const normalized = normalizeIrcMessagingTarget(entry);
    return normalized && isChannelTarget(normalized) ? normalized : null;
  },
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveSources: (account) => [
    account.config.channels ?? [],
    Object.keys(account.config.groups ?? {}),
  ],
});

const ircConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedIrcAccount,
  ResolvedIrcAccount,
  CoreConfig
>({
  clearBaseFields: [
    "name",
    "host",
    "port",
    "tls",
    "nick",
    "username",
    "realname",
    "password",
    "passwordFile",
    "channels",
  ],
  defaultAccountId: resolveDefaultIrcAccountId,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeIrcAllowEntry,
    }),
  listAccountIds: listIrcAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveIrcAccount),
  resolveAllowFrom: (account: ResolvedIrcAccount) => account.config.allowFrom,
  resolveDefaultTo: (account: ResolvedIrcAccount) => account.config.defaultTo,
  sectionKey: "irc",
});

const resolveIrcDmPolicy = createScopedDmSecurityResolver<ResolvedIrcAccount>({
  channelKey: "irc",
  normalizeEntry: (raw) => normalizeIrcAllowEntry(raw),
  policyPathSuffix: "dmPolicy",
  resolveAllowFrom: (account) => account.config.allowFrom,
  resolvePolicy: (account) => account.config.dmPolicy,
});

const collectIrcGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedIrcAccount>({
    buildOpenWarning: {
      openBehavior: "allows all channels and senders (mention-gated)",
      remediation: 'Prefer channels.irc.groupPolicy="allowlist" with channels.irc.groups',
      surface: "IRC channels",
    },
    providerConfigPresent: (cfg) => cfg.channels?.irc !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
  });

const collectIrcSecurityWarnings = composeAccountWarningCollectors<
  ResolvedIrcAccount,
  {
    account: ResolvedIrcAccount;
    cfg: CoreConfig;
  }
>(
  collectIrcGroupPolicyWarnings,
  (account) =>
    !account.config.tls &&
    "- IRC TLS is disabled (channels.irc.tls=false); traffic and credentials are plaintext.",
  (account) =>
    account.config.nickserv?.register &&
    '- IRC NickServ registration is enabled (channels.irc.nickserv.register=true); this sends "REGISTER" on every connect. Disable after first successful registration.',
  (account) =>
    account.config.nickserv?.register &&
    !account.config.nickserv.password?.trim() &&
    "- IRC NickServ registration is enabled but no NickServ password is resolved; set channels.irc.nickserv.password, channels.irc.nickserv.passwordFile, or IRC_NICKSERV_PASSWORD.",
);

export const ircPlugin: ChannelPlugin<ResolvedIrcAccount, IrcProbe> = createChatChannelPlugin({
  base: {
    capabilities: {
      blockStreaming: true,
      chatTypes: ["direct", "group"],
      media: true,
    },
    config: {
      ...ircConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            host: account.host,
            nick: account.nick,
            passwordSource: account.passwordSource,
            port: account.port,
            tls: account.tls,
          },
        }),
      hasConfiguredState: ({ env }) =>
        typeof env?.IRC_HOST === "string" &&
        env.IRC_HOST.trim().length > 0 &&
        typeof env?.IRC_NICK === "string" &&
        env.IRC_NICK.trim().length > 0,
      isConfigured: (account) => account.configured,
    },
    configSchema: IrcChannelConfigSchema,
    directory: createChannelDirectoryAdapter({
      listGroups: async (params) => {
        const entries = await listIrcDirectoryGroupsFromConfig(params);
        return entries.map((entry) => ({ ...entry, name: entry.id }));
      },
      listPeers: async (params) => listIrcDirectoryPeersFromConfig(params),
    }),
    doctor: {
      collectMutableAllowlistWarnings: collectIrcMutableAllowlistWarnings,
      groupAllowFromFallbackToAllowFrom: false,
    },
    gateway: {
      startAccount: async (ctx) =>
        await startIrcGatewayAccount({
          ...ctx,
          cfg: ctx.cfg as CoreConfig,
        }),
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        const account = resolveIrcAccount({ accountId, cfg: cfg as CoreConfig });
        if (!groupId) {
          return true;
        }
        const match = resolveIrcGroupMatch({ groups: account.config.groups, target: groupId });
        return resolveIrcRequireMention({
          groupConfig: match.groupConfig,
          wildcardConfig: match.wildcardConfig,
        });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId }) => {
        const account = resolveIrcAccount({ accountId, cfg: cfg as CoreConfig });
        if (!groupId) {
          return undefined;
        }
        const match = resolveIrcGroupMatch({ groups: account.config.groups, target: groupId });
        return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
      },
    },
    id: "irc",
    messaging: {
      normalizeTarget: normalizeIrcMessagingTarget,
      targetResolver: {
        hint: "<#channel|nick>",
        looksLikeId: looksLikeIrcTargetId,
      },
    },
    meta: {
      ...meta,
      quickstartAllowFrom: true,
    },
    reload: { configPrefixes: ["channels.irc"] },
    resolver: {
      resolveTargets: async ({ inputs, kind }) => inputs.map((input) => {
          const normalized = normalizeIrcMessagingTarget(input);
          if (!normalized) {
            return {
              input,
              resolved: false,
              note: "invalid IRC target",
            };
          }
          if (kind === "group") {
            const groupId = isChannelTarget(normalized) ? normalized : `#${normalized}`;
            return {
              input,
              resolved: true,
              id: groupId,
              name: groupId,
            };
          }
          if (isChannelTarget(normalized)) {
            return {
              input,
              resolved: false,
              note: "expected user target",
            };
          }
          return {
            input,
            resolved: true,
            id: normalized,
            name: normalized,
          };
        }),
    },
    secrets: {
      collectRuntimeConfigAssignments,
      secretTargetRegistryEntries,
    },
    setup: ircSetupAdapter,
    setupWizard: ircSetupWizard,
    status: createComputedAccountStatusAdapter<ResolvedIrcAccount, IrcProbe>({
      buildChannelSummary: ({ account, snapshot }) => ({
        ...buildBaseChannelStatusSummary(snapshot),
        host: account.host,
        port: snapshot.port,
        tls: account.tls,
        nick: account.nick,
        probe: snapshot.probe,
        lastProbeAt: snapshot.lastProbeAt ?? null,
      }),
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      probeAccount: async ({ cfg, account, timeoutMs }) =>
        probeIrc(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          host: account.host,
          port: account.port,
          tls: account.tls,
          nick: account.nick,
          passwordSource: account.passwordSource,
        },
      }),
    }),
  },
  outbound: {
    attachedResults: {
      channel: "irc",
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
        const { sendMessageIrc } = await loadIrcChannelRuntime();
        return await sendMessageIrc(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
          accountId: accountId ?? undefined,
          cfg: cfg as CoreConfig,
          replyTo: replyToId ?? undefined,
        });
      },
      sendText: async ({ cfg, to, text, accountId, replyToId }) => {
        const { sendMessageIrc } = await loadIrcChannelRuntime();
        return await sendMessageIrc(to, text, {
          accountId: accountId ?? undefined,
          cfg: cfg as CoreConfig,
          replyTo: replyToId ?? undefined,
        });
      },
    },
    base: ircOutboundBaseAdapter,
  },
  pairing: {
    text: {
      idLabel: "ircUser",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => normalizeIrcAllowEntry(entry),
      notify: async ({ id, message }) => {
        const target = normalizePairingTarget(id);
        if (!target) {
          throw new Error(`invalid IRC pairing id: ${id}`);
        }
        const { sendMessageIrc } = await loadIrcChannelRuntime();
        await sendMessageIrc(target, message);
      },
    },
  },
  security: {
    collectWarnings: collectIrcSecurityWarnings,
    resolveDmPolicy: resolveIrcDmPolicy,
  },
});
