import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderGroupPolicyWarningCollector,
  projectConfigWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { msteamsActionsAdapter } from "./actions.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  PAIRING_APPROVED_MESSAGE,
  buildProbeChannelStatusSummary,
  chunkTextForOutbound,
  createDefaultChannelRuntimeState,
} from "./channel-api.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsDirectoryAdapter } from "./directory.js";
import { collectMSTeamsMutableAllowlistWarnings } from "./doctor.js";
import { formatUnknownError } from "./errors.js";
import { resolveMSTeamsGroupToolPolicy } from "./policy.js";
import type { ProbeMSTeamsResult } from "./probe.js";
import {
  looksLikeMSTeamsTargetId,
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";
import { msteamsSetupAdapter } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";
import { resolveMSTeamsCredentials } from "./token.js";

interface ResolvedMSTeamsAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
}

const meta = {
  aliases: ["teams"],
  blurb: "Teams SDK; enterprise support.",
  docsLabel: "msteams",
  docsPath: "/channels/msteams",
  id: "msteams",
  label: "Microsoft Teams",
  order: 60,
  selectionLabel: "Microsoft Teams (Bot Framework)",
} as const;

const TEAMS_GRAPH_PERMISSION_HINTS: Record<string, string> = {
  "Channel.ReadBasic.All": "channel list",
  "ChannelMessage.Read.All": "channel history",
  "Chat.Read.All": "chat history",
  "Files.Read.All": "files (OneDrive)",
  "Sites.Read.All": "files (SharePoint)",
  "Team.ReadBasic.All": "team list",
  "TeamsActivity.Read.All": "teams activity",
};

const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
}>({
  collect: ({ groupPolicy }) =>
    groupPolicy === "open"
      ? [
          '- MS Teams groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.msteams.groupPolicy="allowlist" + channels.msteams.groupAllowFrom to restrict senders.',
        ]
      : [],
  providerConfigPresent: (cfg) => cfg.channels?.msteams !== undefined,
  resolveGroupPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy,
});

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

const resolveMSTeamsChannelConfig = (cfg: OpenClawConfig) => ({
  allowFrom: cfg.channels?.msteams?.allowFrom,
  defaultTo: cfg.channels?.msteams?.defaultTo,
});

const msteamsConfigAdapter = createTopLevelChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  {
    allowFrom?: (string | number)[];
    defaultTo?: string;
  }
>({
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveAccessorAccount: ({ cfg }) => resolveMSTeamsChannelConfig(cfg),
  resolveAccount: (cfg) => ({
    accountId: DEFAULT_ACCOUNT_ID,
    configured: Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    enabled: cfg.channels?.msteams?.enabled !== false,
  }),
  resolveAllowFrom: (account) => account.allowFrom,
  resolveDefaultTo: (account) => account.defaultTo,
  sectionKey: "msteams",
});

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult> =
  createChatChannelPlugin({
    base: {
      actions: msteamsActionsAdapter,
      agentPrompt: {
        messageToolHints: () => [
          "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.",
          "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.",
        ],
      },
      approvalCapability: msTeamsApprovalAuth,
      capabilities: {
        chatTypes: ["direct", "channel", "thread"],
        media: true,
        polls: true,
        threads: true,
      },
      config: {
        ...msteamsConfigAdapter,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
          }),
        isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
      },
      configSchema: MSTeamsChannelConfigSchema,
      directory: msteamsDirectoryAdapter,
      doctor: {
        collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings,
        dmAllowFromMode: "topOnly",
        groupAllowFromFallbackToAllowFrom: false,
        groupModel: "hybrid",
        warnOnEmptyGroupSenderAllowlist: true,
      },
      gateway: {
        startAccount: async (ctx) => {
          const { monitorMSTeamsProvider } = await import("./index.js");
          const port = ctx.cfg.channels?.msteams?.webhook?.port ?? 3978;
          ctx.setStatus({ accountId: ctx.accountId, port });
          ctx.log?.info(`starting provider (port ${port})`);
          return monitorMSTeamsProvider({
            abortSignal: ctx.abortSignal,
            cfg: ctx.cfg,
            runtime: ctx.runtime,
          });
        },
      },
      groups: {
        resolveToolPolicy: resolveMSTeamsGroupToolPolicy,
      },
      id: "msteams",
      messaging: {
        normalizeTarget: normalizeMSTeamsMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveMSTeamsOutboundSessionRoute(params),
        targetResolver: {
          hint: "<conversationId|user:ID|conversation:ID>",
          looksLikeId: (raw) => looksLikeMSTeamsTargetId(raw),
        },
      },
      meta: {
        ...meta,
        aliases: [...meta.aliases],
      },
      reload: { configPrefixes: ["channels.msteams"] },
      resolver: {
        resolveTargets: async ({ cfg, inputs, kind, runtime }) => {
          const results = inputs.map((input) => ({
            id: undefined as string | undefined,
            input,
            name: undefined as string | undefined,
            note: undefined as string | undefined,
            resolved: false,
          }));
          type ResolveTargetResultEntry = (typeof results)[number];
          interface PendingTargetEntry {
            input: string;
            query: string;
            index: number;
          }

          const stripPrefix = (value: string) => normalizeMSTeamsUserInput(value);
          const markPendingLookupFailed = (pending: PendingTargetEntry[]) => {
            pending.forEach(({ index }) => {
              const entry = results[index];
              if (entry) {
                entry.note = "lookup failed";
              }
            });
          };
          const resolvePending = async <T>(
            pending: PendingTargetEntry[],
            resolveEntries: (entries: string[]) => Promise<T[]>,
            applyResolvedEntry: (target: ResolveTargetResultEntry, entry: T) => void,
          ) => {
            if (pending.length === 0) {
              return;
            }
            try {
              const resolved = await resolveEntries(pending.map((entry) => entry.query));
              resolved.forEach((entry, idx) => {
                const target = results[pending[idx]?.index ?? -1];
                if (!target) {
                  return;
                }
                applyResolvedEntry(target, entry);
              });
            } catch (error) {
              runtime.error?.(`msteams resolve failed: ${formatUnknownError(error)}`);
              markPendingLookupFailed(pending);
            }
          };

          if (kind === "user") {
            const pending: PendingTargetEntry[] = [];
            results.forEach((entry, index) => {
              const trimmed = entry.input.trim();
              if (!trimmed) {
                entry.note = "empty input";
                return;
              }
              const cleaned = stripPrefix(trimmed);
              if (/^[0-9a-fA-F-]{16,}$/.test(cleaned) || cleaned.includes("@")) {
                entry.resolved = true;
                entry.id = cleaned;
                return;
              }
              pending.push({ index, input: entry.input, query: cleaned });
            });

            await resolvePending(
              pending,
              (entries) => resolveMSTeamsUserAllowlist({ cfg, entries }),
              (target, entry) => {
                target.resolved = entry.resolved;
                target.id = entry.id;
                target.name = entry.name;
                target.note = entry.note;
              },
            );

            return results;
          }

          const pending: PendingTargetEntry[] = [];
          results.forEach((entry, index) => {
            const trimmed = entry.input.trim();
            if (!trimmed) {
              entry.note = "empty input";
              return;
            }
            const conversationId = parseMSTeamsConversationId(trimmed);
            if (conversationId !== null) {
              entry.resolved = Boolean(conversationId);
              entry.id = conversationId || undefined;
              entry.note = conversationId ? "conversation id" : "empty conversation id";
              return;
            }
            const parsed = parseMSTeamsTeamChannelInput(trimmed);
            if (!parsed.team) {
              entry.note = "missing team";
              return;
            }
            const query = parsed.channel ? `${parsed.team}/${parsed.channel}` : parsed.team;
            pending.push({ index, input: entry.input, query });
          });

          await resolvePending(
            pending,
            (entries) => resolveMSTeamsChannelAllowlist({ cfg, entries }),
            (target, entry) => {
              if (!entry.resolved || !entry.teamId) {
                target.resolved = false;
                target.note = entry.note;
                return;
              }
              target.resolved = true;
              if (entry.channelId) {
                target.id = `${entry.teamId}/${entry.channelId}`;
                target.name =
                  entry.channelName && entry.teamName
                    ? `${entry.teamName}/${entry.channelName}`
                    : (entry.channelName ?? entry.teamName);
              } else {
                target.id = entry.teamId;
                target.name = entry.teamName;
                target.note = "team id";
              }
              if (entry.note) {
                target.note = entry.note;
              }
            },
          );

          return results;
        },
      },
      secrets: {
        collectRuntimeConfigAssignments,
        secretTargetRegistryEntries,
      },
      setup: msteamsSetupAdapter,
      setupWizard: msteamsSetupWizard,
      status: createComputedAccountStatusAdapter<ResolvedMSTeamsAccount, ProbeMSTeamsResult>({
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, {
            port: snapshot.port ?? null,
          }),
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        formatCapabilitiesProbe: ({ probe }) => {
          const teamsProbe = probe as ProbeMSTeamsResult | undefined;
          const lines: Array<{ text: string; tone?: "error" }> = [];
          const appId = normalizeOptionalString(teamsProbe?.appId) ?? "";
          if (appId) {
            lines.push({ text: `App: ${appId}` });
          }
          const graph = teamsProbe?.graph;
          if (graph) {
            const roles = Array.isArray(graph.roles)
              ? graph.roles.map((role) => String(role).trim()).filter(Boolean)
              : [];
            const scopes = Array.isArray(graph.scopes)
              ? graph.scopes.map((scope) => String(scope).trim()).filter(Boolean)
              : [];
            const formatPermission = (permission: string) => {
              const hint = TEAMS_GRAPH_PERMISSION_HINTS[permission];
              return hint ? `${permission} (${hint})` : permission;
            };
            if (!graph.ok) {
              lines.push({ text: `Graph: ${graph.error ?? "failed"}`, tone: "error" });
            } else if (roles.length > 0 || scopes.length > 0) {
              if (roles.length > 0) {
                lines.push({ text: `Graph roles: ${roles.map(formatPermission).join(", ")}` });
              }
              if (scopes.length > 0) {
                lines.push({ text: `Graph scopes: ${scopes.map(formatPermission).join(", ")}` });
              }
            } else if (graph.ok) {
              lines.push({ text: "Graph: ok" });
            }
          }
          return lines;
        },
        probeAccount: async ({ cfg }) =>
          await (await loadMSTeamsChannelRuntime()).probeMSTeams(cfg.channels?.msteams),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            port: runtime?.port ?? null,
          },
        }),
      }),
      streaming: {
        blockStreamingCoalesceDefaults: { idleMs: 1000, minChars: 1500 },
      },
    },
    outbound: {
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      deliveryMode: "direct",
      pollMaxOptions: 12,
      textChunkLimit: 4000,
      ...createRuntimeOutboundDelegates({
        getRuntime: loadMSTeamsChannelRuntime,
        sendMedia: { resolve: (runtime) => runtime.msteamsOutbound.sendMedia },
        sendPoll: { resolve: (runtime) => runtime.msteamsOutbound.sendPoll },
        sendText: { resolve: (runtime) => runtime.msteamsOutbound.sendText },
      }),
    },
    pairing: {
      text: {
        idLabel: "msteamsUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(msteams|user):/i),
        notify: async ({ cfg, id, message }) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          await sendMessageMSTeams({
            cfg,
            text: message,
            to: id,
          });
        },
      },
    },
    security: {
      collectWarnings: projectConfigWarningCollector<{ cfg: OpenClawConfig }>(
        collectMSTeamsSecurityWarnings,
      ),
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) => ({
        currentChannelId: normalizeOptionalString(context.To),
        currentThreadTs: context.ReplyToId,
        hasRepliedRef,
      }),
    },
  });
