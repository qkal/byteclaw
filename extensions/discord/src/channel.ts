import { createRequire } from "node:module";
import {
  buildLegacyDmAccountAllowlistAdapter,
  createAccountScopedAllowlistNameResolver,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createOpenProviderConfiguredRouteWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { resolveTargetsWithOptionalToken } from "openclaw/plugin-sdk/target-resolver-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedDiscordAccount,
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "./accounts.js";
import { getDiscordApprovalCapability } from "./approval-native.js";
import { discordMessageActions as discordMessageActionsImpl } from "./channel-actions.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  PAIRING_APPROVED_MESSAGE,
  buildTokenChannelStatusSummary,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "./channel-api.js";
import { resolveDiscordCurrentConversationIdentity } from "./conversation-identity.js";
import { shouldSuppressLocalDiscordExecApprovalPrompt } from "./exec-approvals.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";
import { isLikelyDiscordVideoMedia } from "./media-detection.js";
import {
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
} from "./monitor/thread-bindings.session-updates.js";
import {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./normalize.js";
import { resolveDiscordOutboundSessionRoute } from "./outbound-session-route.js";
import type { DiscordProbe } from "./probe.js";
import { getDiscordRuntime } from "./runtime.js";
import { normalizeExplicitDiscordSessionKey } from "./session-key-normalization.js";
import { discordSetupAdapter } from "./setup-adapter.js";
import { createDiscordPluginBase, discordConfigAdapter } from "./shared.js";
import { collectDiscordStatusIssues } from "./status-issues.js";
import { parseDiscordTarget } from "./target-parsing.js";
import { DiscordUiContainer } from "./ui.js";

type DiscordSendFn = typeof import("./send.js").sendMessageDiscord;
type DiscordCarbonModule = typeof import("@buape/carbon");
type DiscordTextDisplay = InstanceType<DiscordCarbonModule["TextDisplay"]>;
type DiscordSeparator = InstanceType<DiscordCarbonModule["Separator"]>;

let discordProviderRuntimePromise:
  | Promise<typeof import("./monitor/provider.runtime.js")>
  | undefined;
let discordProbeRuntimePromise: Promise<typeof import("./probe.runtime.js")> | undefined;
let discordAuditModulePromise: Promise<typeof import("./audit.js")> | undefined;
let discordSendModulePromise: Promise<typeof import("./send.js")> | undefined;
let discordDirectoryLiveModulePromise: Promise<typeof import("./directory-live.js")> | undefined;
let discordCarbonModuleCache: DiscordCarbonModule | null = null;

const loadDiscordDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
const loadDiscordSecurityAuditModule = createLazyRuntimeModule(
  () => import("./security-audit.runtime.js"),
);
const loadDiscordResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
const loadDiscordResolveUsersModule = createLazyRuntimeModule(() => import("./resolve-users.js"));
const loadDiscordThreadBindingsManagerModule = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.manager.js"),
);

const require = createRequire(import.meta.url);

async function loadDiscordProviderRuntime() {
  discordProviderRuntimePromise ??= import("./monitor/provider.runtime.js");
  return await discordProviderRuntimePromise;
}

async function loadDiscordProbeRuntime() {
  discordProbeRuntimePromise ??= import("./probe.runtime.js");
  return await discordProbeRuntimePromise;
}

async function loadDiscordAuditModule() {
  discordAuditModulePromise ??= import("./audit.js");
  return await discordAuditModulePromise;
}

async function loadDiscordSendModule() {
  discordSendModulePromise ??= import("./send.js");
  return await discordSendModulePromise;
}

async function loadDiscordDirectoryLiveModule() {
  discordDirectoryLiveModulePromise ??= import("./directory-live.js");
  return await discordDirectoryLiveModulePromise;
}

function loadDiscordCarbonModule() {
  discordCarbonModuleCache ??= require("@buape/carbon") as DiscordCarbonModule;
  return discordCarbonModuleCache;
}

const REQUIRED_DISCORD_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;
const DISCORD_ACCOUNT_STARTUP_STAGGER_MS = 10_000;
function resolveDiscordAttachedOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  return threadId ? `channel:${threadId}` : params.to;
}

function shouldTreatDiscordDeliveredTextAsVisible(params: {
  kind: "tool" | "block" | "final";
  text?: string;
}): boolean {
  return (
    params.kind === "block" && typeof params.text === "string" && params.text.trim().length > 0
  );
}

function resolveRuntimeDiscordMessageActions() {
  try {
    return getDiscordRuntime().channel?.discord?.messageActions ?? null;
  } catch {
    return null;
  }
}

function resolveOptionalDiscordRuntime() {
  try {
    return getDiscordRuntime();
  } catch {
    return null;
  }
}

async function resolveDiscordSend(deps?: Record<string, unknown>): Promise<DiscordSendFn> {
  return (
    resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
    resolveOptionalDiscordRuntime()?.channel?.discord?.sendMessageDiscord ??
    (await loadDiscordSendModule()).sendMessageDiscord
  );
}

const discordMessageActions = {
  describeMessageTool: (
    ctx: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0],
  ): ChannelMessageToolDiscovery | null =>
    resolveRuntimeDiscordMessageActions()?.describeMessageTool?.(ctx) ??
    discordMessageActionsImpl.describeMessageTool?.(ctx) ??
    null,
  extractToolSend: (
    ctx: Parameters<NonNullable<ChannelMessageActionAdapter["extractToolSend"]>>[0],
  ) =>
    resolveRuntimeDiscordMessageActions()?.extractToolSend?.(ctx) ??
    discordMessageActionsImpl.extractToolSend?.(ctx) ??
    null,
  handleAction: async (
    ctx: Parameters<NonNullable<ChannelMessageActionAdapter["handleAction"]>>[0],
  ) => {
    const runtimeHandleAction = resolveRuntimeDiscordMessageActions()?.handleAction;
    if (runtimeHandleAction) {
      return await runtimeHandleAction(ctx);
    }
    if (!discordMessageActionsImpl.handleAction) {
      throw new Error("Discord message actions not available");
    }
    return await discordMessageActionsImpl.handleAction(ctx);
  },
};

function resolveDiscordStartupDelayMs(cfg: OpenClawConfig, accountId: string): number {
  const startupAccountIds = listDiscordAccountIds(cfg).filter((candidateId) => {
    const candidate = resolveDiscordAccount({ accountId: candidateId, cfg });
    return (
      candidate.enabled &&
      (resolveConfiguredFromCredentialStatuses(candidate) ??
        Boolean(normalizeOptionalString(candidate.token)))
    );
  });
  const startupIndex = startupAccountIds.findIndex((candidateId) => candidateId === accountId);
  return startupIndex <= 0 ? 0 : startupIndex * DISCORD_ACCOUNT_STARTUP_STAGGER_MS;
}

const resolveDiscordDmPolicy = createScopedDmSecurityResolver<ResolvedDiscordAccount>({
  allowFromPathSuffix: "dm.",
  channelKey: "discord",
  normalizeEntry: (raw) =>
    raw
      .trim()
      .replace(/^(discord|user):/i, "")
      .replace(/^<@!?(\d+)>$/, "$1"),
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  resolvePolicy: (account) => account.config.dm?.policy,
});

function formatDiscordIntents(intents?: {
  messageContent?: string;
  guildMembers?: string;
  presence?: string;
}) {
  if (!intents) {
    return "unknown";
  }
  return [
    `messageContent=${intents.messageContent ?? "unknown"}`,
    `guildMembers=${intents.guildMembers ?? "unknown"}`,
    `presence=${intents.presence ?? "unknown"}`,
  ].join(" ");
}

function buildDiscordCrossContextComponents(params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const { Separator, TextDisplay } = loadDiscordCarbonModule();
  const trimmed = params.message.trim();
  const components: (DiscordTextDisplay | DiscordSeparator)[] = [];
  if (trimmed) {
    components.push(new TextDisplay(params.message));
    components.push(new Separator({ divider: true, spacing: "small" }));
  }
  components.push(new TextDisplay(`*From ${params.originLabel}*`));
  return [new DiscordUiContainer({ accountId: params.accountId, cfg: params.cfg, components })];
}

const resolveDiscordAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  innerLabel: (guildKey, channelKey) => `guild ${guildKey} / channel ${channelKey}`,
  outerLabel: (guildKey) => `guild ${guildKey}`,
  resolveChildren: (guildCfg) => guildCfg?.channels,
  resolveInnerEntries: (channelCfg) => channelCfg?.users,
  resolveOuterEntries: (guildCfg) => guildCfg?.users,
  resolveRecord: (account: ResolvedDiscordAccount) => account.config.guilds,
});

const resolveDiscordAllowlistNames = createAccountScopedAllowlistNameResolver({
  resolveAccount: resolveDiscordAccount,
  resolveNames: async ({ token, entries }) =>
    (await loadDiscordResolveUsersModule()).resolveDiscordUserAllowlist({ entries, token }),
  resolveToken: (account: ResolvedDiscordAccount) => account.token,
});

const collectDiscordSecurityWarnings =
  createOpenProviderConfiguredRouteWarningCollector<ResolvedDiscordAccount>({
    configureRouteAllowlist: {
      groupPolicyPath: "channels.discord.groupPolicy",
      openScope: "any channel not explicitly denied",
      routeAllowlistPath: "channels.discord.guilds.<id>.channels",
      surface: "Discord guilds",
    },
    missingRouteAllowlist: {
      openBehavior: "with no guild/channel allowlist; any channel can trigger (mention-gated)",
      remediation:
        'Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels',
      surface: "Discord guilds",
    },
    providerConfigPresent: (cfg) => cfg.channels?.discord !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Object.keys(account.config.guilds ?? {}).length > 0,
  });

function normalizeDiscordAcpConversationId(conversationId: string) {
  const normalized = conversationId.trim();
  return normalized ? { conversationId: normalized } : null;
}

function matchDiscordAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  if (params.bindingConversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    params.bindingConversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

function resolveDiscordConversationIdFromTargets(
  targets: (string | undefined)[],
): string | undefined {
  for (const raw of targets) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const target = parseDiscordTarget(trimmed, { defaultKind: "channel" });
      if (target?.normalized) {
        return target.normalized;
      }
    } catch {
      const mentionMatch = trimmed.match(/^<#(\d+)>$/);
      if (mentionMatch?.[1]) {
        return `channel:${mentionMatch[1]}`;
      }
      if (/^\d{6,}$/.test(trimmed)) {
        return normalizeDiscordMessagingTarget(trimmed);
      }
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeLowercaseStringOrEmpty(raw);
  if (!sessionKey) {
    return undefined;
  }
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

function resolveDiscordCommandConversation(params: {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  from?: string;
  chatType?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const targets = [params.originatingTo, params.commandTo, params.fallbackTo];
  if (params.threadId) {
    const parentConversationId =
      normalizeDiscordMessagingTarget(normalizeOptionalString(params.threadParentId) ?? "") ||
      parseDiscordParentChannelFromSessionKey(params.parentSessionKey) ||
      resolveDiscordConversationIdFromTargets(targets);
    return {
      conversationId: params.threadId,
      ...(parentConversationId && parentConversationId !== params.threadId
        ? { parentConversationId }
        : {}),
    };
  }
  const conversationId = resolveDiscordCurrentConversationIdentity({
    chatType: params.chatType,
    commandTo: params.commandTo,
    fallbackTo: params.fallbackTo,
    from: params.from,
    originatingTo: params.originatingTo,
  });
  return conversationId ? { conversationId } : null;
}

function resolveDiscordInboundConversation(params: {
  from?: string;
  to?: string;
  conversationId?: string;
  isGroup: boolean;
}) {
  const conversationId = resolveDiscordCurrentConversationIdentity({
    chatType: params.isGroup ? "group" : "direct",
    fallbackTo: params.conversationId,
    from: params.from,
    originatingTo: params.to,
  });
  return conversationId ? { conversationId } : null;
}

function toConversationLifecycleBinding(binding: {
  boundAt: number;
  lastActivityAt?: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}) {
  return {
    boundAt: binding.boundAt,
    idleTimeoutMs: typeof binding.idleTimeoutMs === "number" ? binding.idleTimeoutMs : undefined,
    lastActivityAt:
      typeof binding.lastActivityAt === "number" ? binding.lastActivityAt : binding.boundAt,
    maxAgeMs: typeof binding.maxAgeMs === "number" ? binding.maxAgeMs : undefined,
  };
}

function parseDiscordExplicitTarget(raw: string) {
  try {
    const target = parseDiscordTarget(raw, { defaultKind: "channel" });
    if (!target) {
      return null;
    }
    return {
      chatType: target.kind === "user" ? ("direct" as const) : ("channel" as const),
      to: target.id,
    };
  } catch {
    return null;
  }
}

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount, DiscordProbe> =
  createChatChannelPlugin<ResolvedDiscordAccount, DiscordProbe>({
    base: {
      ...createDiscordPluginBase({
        setup: discordSetupAdapter,
      }),
      actions: discordMessageActions,
      agentPrompt: {
        messageToolHints: () => [
          "- Discord components: set `components` when sending messages to include buttons, selects, or v2 containers.",
          "- Forms: add `components.modal` (title, fields). OpenClaw adds a trigger button and routes submissions as new messages.",
        ],
      },
      allowlist: {
        ...buildLegacyDmAccountAllowlistAdapter({
          channelId: "discord",
          normalize: ({ cfg, accountId, values }) =>
            discordConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
          resolveAccount: resolveDiscordAccount,
          resolveDmAllowFrom: (account) => account.config.allowFrom ?? account.config.dm?.allowFrom,
          resolveGroupOverrides: resolveDiscordAllowlistGroupOverrides,
          resolveGroupPolicy: (account) => account.config.groupPolicy,
        }),
        resolveNames: resolveDiscordAllowlistNames,
      },
      approvalCapability: getDiscordApprovalCapability(),
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeDiscordAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchDiscordAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
        resolveCommandConversation: ({
          threadId,
          threadParentId,
          parentSessionKey,
          from,
          chatType,
          originatingTo,
          commandTo,
          fallbackTo,
        }) =>
          resolveDiscordCommandConversation({
            chatType,
            commandTo,
            fallbackTo,
            from,
            originatingTo,
            parentSessionKey,
            threadId,
            threadParentId,
          }),
      },
      conversationBindings: {
        createManager: async ({ cfg, accountId }) =>
          (await loadDiscordThreadBindingsManagerModule()).createThreadBindingManager({
            accountId: accountId ?? undefined,
            cfg,
            enableSweeper: false,
            persist: false,
          }),
        defaultTopLevelPlacement: "child",
        setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
          setThreadBindingIdleTimeoutBySessionKey({
            accountId: accountId ?? undefined,
            idleTimeoutMs,
            targetSessionKey,
          }).map(toConversationLifecycleBinding),
        setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
          setThreadBindingMaxAgeBySessionKey({
            accountId: accountId ?? undefined,
            maxAgeMs,
            targetSessionKey,
          }).map(toConversationLifecycleBinding),
        supportsCurrentConversationBinding: true,
      },
      directory: createChannelDirectoryAdapter({
        listGroups: async (params) =>
          (await loadDiscordDirectoryConfigModule()).listDiscordDirectoryGroupsFromConfig(params),
        listPeers: async (params) =>
          (await loadDiscordDirectoryConfigModule()).listDiscordDirectoryPeersFromConfig(params),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadDiscordDirectoryLiveModule,
          listGroupsLive: (runtime) => runtime.listDiscordDirectoryGroupsLive,
          listPeersLive: (runtime) => runtime.listDiscordDirectoryPeersLive,
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { account } = ctx;
          const startupDelayMs = resolveDiscordStartupDelayMs(ctx.cfg, account.accountId);
          if (startupDelayMs > 0) {
            ctx.log?.info(
              `[${account.accountId}] delaying provider startup ${Math.round(startupDelayMs / 1000)}s to reduce Discord startup rate limits`,
            );
            try {
              await sleepWithAbort(startupDelayMs, ctx.abortSignal);
            } catch {
              return;
            }
          }
          const token = account.token.trim();
          let discordBotLabel = "";
          try {
            const probe = await (
              await loadDiscordProbeRuntime()
            ).probeDiscord(token, 2500, {
              includeApplication: true,
            });
            const username = probe.ok ? probe.bot?.username?.trim() : null;
            if (username) {
              discordBotLabel = ` (@${username})`;
            }
            ctx.setStatus({
              accountId: account.accountId,
              application: probe.application,
              bot: probe.bot,
            });
            const messageContent = probe.application?.intents?.messageContent;
            if (messageContent === "disabled") {
              ctx.log?.warn(
                `[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`,
              );
            } else if (messageContent === "limited") {
              ctx.log?.info(
                `[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`,
              );
            }
          } catch (error) {
            if (getDiscordRuntime().logging.shouldLogVerbose()) {
              ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(error)}`);
            }
          }
          ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
          return (await loadDiscordProviderRuntime()).monitorDiscordProvider({
            abortSignal: ctx.abortSignal,
            accountId: account.accountId,
            channelRuntime: ctx.channelRuntime,
            config: ctx.cfg,
            historyLimit: account.config.historyLimit,
            mediaMaxMb: account.config.mediaMaxMb,
            runtime: ctx.runtime,
            setStatus: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
            token,
          });
        },
      },
      groups: {
        resolveRequireMention: resolveDiscordGroupRequireMention,
        resolveToolPolicy: resolveDiscordGroupToolPolicy,
      },
      mentions: {
        stripPatterns: () => [String.raw`<@!?\d+>`],
      },
      messaging: {
        buildCrossContextComponents: buildDiscordCrossContextComponents,
        inferTargetChatType: ({ to }) => parseDiscordExplicitTarget(to)?.chatType,
        normalizeExplicitSessionKey: ({ sessionKey, ctx }) =>
          normalizeExplicitDiscordSessionKey(sessionKey, ctx),
        normalizeTarget: normalizeDiscordMessagingTarget,
        parseExplicitTarget: ({ raw }) => parseDiscordExplicitTarget(raw),
        resolveInboundConversation: ({ from, to, conversationId, isGroup }) =>
          resolveDiscordInboundConversation({ conversationId, from, isGroup, to }),
        resolveOutboundSessionRoute: (params) => resolveDiscordOutboundSessionRoute(params),
        resolveSessionTarget: ({ id }) => normalizeDiscordMessagingTarget(`channel:${id}`),
        targetResolver: {
          hint: "<channelId|user:ID|channel:ID>",
          looksLikeId: looksLikeDiscordTargetId,
        },
      },
      resolver: {
        resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
          const account = resolveDiscordAccount({ accountId, cfg });
          if (kind === "group") {
            return resolveTargetsWithOptionalToken({
              inputs,
              mapResolved: (entry) => ({
                input: entry.input,
                resolved: entry.resolved,
                id: entry.channelId ?? entry.guildId,
                name:
                  entry.channelName ??
                  entry.guildName ??
                  (entry.guildId && !entry.channelId ? entry.guildId : undefined),
                note: entry.note,
              }),
              missingTokenNote: "missing Discord token",
              resolveWithToken: async ({ token, inputs }) =>
                (await loadDiscordResolveChannelsModule()).resolveDiscordChannelAllowlist({
                  token,
                  entries: inputs,
                }),
              token: account.token,
            });
          }
          return resolveTargetsWithOptionalToken({
            inputs,
            mapResolved: (entry) => ({
              input: entry.input,
              resolved: entry.resolved,
              id: entry.id,
              name: entry.name,
              note: entry.note,
            }),
            missingTokenNote: "missing Discord token",
            resolveWithToken: async ({ token, inputs }) =>
              (await loadDiscordResolveUsersModule()).resolveDiscordUserAllowlist({
                token,
                entries: inputs,
              }),
            token: account.token,
          });
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedDiscordAccount, DiscordProbe>({
        auditAccount: async ({ account, timeoutMs, cfg }) => {
          const { auditDiscordChannelPermissions, collectDiscordAuditChannelIds } =
            await loadDiscordAuditModule();
          const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
            cfg,
            accountId: account.accountId,
          });
          if (!channelIds.length && unresolvedChannels === 0) {
            return undefined;
          }
          const botToken = account.token?.trim();
          if (!botToken) {
            return {
              ok: unresolvedChannels === 0,
              checkedChannels: 0,
              unresolvedChannels,
              channels: [],
              elapsedMs: 0,
            };
          }
          const audit = await auditDiscordChannelPermissions({
            token: botToken,
            accountId: account.accountId,
            channelIds,
            timeoutMs,
          });
          return { ...audit, unresolvedChannels };
        },
        buildCapabilitiesDiagnostics: async ({ account, target }) => {
          if (!target?.trim()) {
            return undefined;
          }
          const parsedTarget = parseDiscordTarget(target.trim(), { defaultKind: "channel" });
          const details: Record<string, unknown> = {
            target: {
              raw: target,
              normalized: parsedTarget?.normalized,
              kind: parsedTarget?.kind,
              channelId: parsedTarget?.kind === "channel" ? parsedTarget.id : undefined,
            },
          };
          if (!parsedTarget || parsedTarget.kind !== "channel") {
            return {
              details,
              lines: [
                {
                  text: "Permissions: Target looks like a DM user; pass channel:<id> to audit channel permissions.",
                  tone: "error",
                },
              ],
            };
          }
          const token = account.token?.trim();
          if (!token) {
            return {
              details,
              lines: [
                {
                  text: "Permissions: Discord bot token missing for permission audit.",
                  tone: "error",
                },
              ],
            };
          }
          try {
            const perms = await (
              await loadDiscordSendModule()
            ).fetchChannelPermissionsDiscord(parsedTarget.id, {
              token,
              accountId: account.accountId ?? undefined,
            });
            const missingRequired = REQUIRED_DISCORD_PERMISSIONS.filter(
              (permission) => !perms.permissions.includes(permission),
            );
            details.permissions = {
              channelId: perms.channelId,
              guildId: perms.guildId,
              isDm: perms.isDm,
              channelType: perms.channelType,
              permissions: perms.permissions,
              missingRequired,
              raw: perms.raw,
            };
            return {
              details,
              lines: [
                {
                  text: `Permissions (${perms.channelId}): ${perms.permissions.length ? perms.permissions.join(", ") : "none"}`,
                },
                missingRequired.length > 0
                  ? { text: `Missing required: ${missingRequired.join(", ")}`, tone: "warn" }
                  : { text: "Missing required: none", tone: "success" },
              ],
            };
          } catch (err) {
            const message = formatErrorMessage(err);
            details.permissions = { channelId: parsedTarget.id, error: message };
            return {
              details,
              lines: [{ text: `Permissions: ${message}`, tone: "error" }],
            };
          }
        },
        buildChannelSummary: ({ snapshot }) =>
          buildTokenChannelStatusSummary(snapshot, { includeMode: false }),
        collectStatusIssues: collectDiscordStatusIssues,
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastEventAt: null,
        }),
        formatCapabilitiesProbe: ({ probe }) => {
          const discordProbe = probe as DiscordProbe | undefined;
          const lines = [];
          if (discordProbe?.bot?.username) {
            const botId = discordProbe.bot.id ? ` (${discordProbe.bot.id})` : "";
            lines.push({ text: `Bot: @${discordProbe.bot.username}${botId}` });
          }
          if (discordProbe?.application?.intents) {
            lines.push({
              text: `Intents: ${formatDiscordIntents(discordProbe.application.intents)}`,
            });
          }
          return lines;
        },
        probeAccount: async ({ account, timeoutMs }) =>
          (await loadDiscordProbeRuntime()).probeDiscord(account.token, timeoutMs, {
            includeApplication: true,
          }),
        resolveAccountSnapshot: ({ account, runtime, probe, audit }) => {
          const configured =
            resolveConfiguredFromCredentialStatuses(account) ?? Boolean(account.token?.trim());
          const app = runtime?.application ?? (probe as { application?: unknown })?.application;
          const bot = runtime?.bot ?? (probe as { bot?: unknown })?.bot;
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured,
            extra: {
              ...projectCredentialSnapshotFields(account),
              connected: runtime?.connected ?? false,
              reconnectAttempts: runtime?.reconnectAttempts,
              lastConnectedAt: runtime?.lastConnectedAt ?? null,
              lastDisconnect: runtime?.lastDisconnect ?? null,
              lastEventAt: runtime?.lastEventAt ?? null,
              application: app ?? undefined,
              bot: bot ?? undefined,
              audit,
            },
          };
        },
      }),
    },
    outbound: {
      attachedResults: {
        channel: "discord",
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          deps,
          replyToId,
          threadId,
          silent,
        }) => {
          const send = await resolveDiscordSend(deps);
          const target = resolveDiscordAttachedOutboundTarget({ threadId, to });
          if (text.trim() && mediaUrl && isLikelyDiscordVideoMedia(mediaUrl)) {
            await send(target, text, {
              accountId: accountId ?? undefined,
              cfg,
              replyTo: replyToId ?? undefined,
              silent: silent ?? undefined,
              verbose: false,
            });
            return await send(target, "", {
              accountId: accountId ?? undefined,
              cfg,
              mediaLocalRoots,
              mediaReadFile,
              mediaUrl,
              silent: silent ?? undefined,
              verbose: false,
            });
          }
          return await send(target, text, {
            accountId: accountId ?? undefined,
            cfg,
            mediaLocalRoots,
            mediaReadFile,
            mediaUrl,
            replyTo: replyToId ?? undefined,
            silent: silent ?? undefined,
            verbose: false,
          });
        },
        sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
          await (
            await loadDiscordSendModule()
          ).sendPollDiscord(resolveDiscordAttachedOutboundTarget({ threadId, to }), poll, {
            accountId: accountId ?? undefined,
            cfg,
            silent: silent ?? undefined,
          }),
        sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, silent }) => {
          const send = await resolveDiscordSend(deps);
          return await send(resolveDiscordAttachedOutboundTarget({ threadId, to }), text, {
            accountId: accountId ?? undefined,
            cfg,
            replyTo: replyToId ?? undefined,
            silent: silent ?? undefined,
            verbose: false,
          });
        },
      },
      base: {
        chunker: null,
        deliveryMode: "direct",
        pollMaxOptions: 10,
        resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
        shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
          shouldSuppressLocalDiscordExecApprovalPrompt({
            accountId,
            cfg,
            payload,
          }),
        shouldTreatDeliveredTextAsVisible: shouldTreatDiscordDeliveredTextAsVisible,
        textChunkLimit: 2000,
      },
    },
    pairing: {
      text: {
        idLabel: "discordUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(discord|user):/i),
        notify: async ({ id, message }) => {
          await (await loadDiscordSendModule()).sendMessageDiscord(`user:${id}`, message);
        },
      },
    },
    security: {
      collectAuditFindings: async (params) =>
        (await loadDiscordSecurityAuditModule()).collectDiscordSecurityAuditFindings(params),
      collectWarnings: collectDiscordSecurityWarnings,
      resolveDmPolicy: resolveDiscordDmPolicy,
    },
    threading: {
      scopedAccountReplyToMode: {
        fallback: "off",
        resolveAccount: (cfg, accountId) => resolveDiscordAccount({ accountId, cfg }),
        resolveReplyToMode: (account) => account.config.replyToMode,
      },
    },
  });
