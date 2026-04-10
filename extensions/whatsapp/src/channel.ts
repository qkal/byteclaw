import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { type ChannelPlugin, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { type ResolvedWhatsAppAccount, resolveWhatsAppAccount } from "./accounts.js";
import { createWhatsAppLoginTool } from "./agent-tools-login.js";
import { whatsappApprovalAuth } from "./approval-auth.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import {
  describeWhatsAppMessageActions,
  resolveWhatsAppAgentReactionGuidance,
} from "./channel-actions.js";
import { whatsappChannelOutbound } from "./channel-outbound.js";
import { whatsappCommandPolicy } from "./command-policy.js";
import { formatWhatsAppConfigAllowFromEntries } from "./config-accessors.js";
import {
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppMentionStripRegexes,
} from "./group-intro.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { resolveWhatsAppHeartbeatRecipients } from "./heartbeat-recipients.js";
import { checkWhatsAppHeartbeatReady } from "./heartbeat.js";
import {
  isWhatsAppGroupJid,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import {
  createWhatsAppPluginBase,
  loadWhatsAppChannelRuntime,
  whatsappSetupWizardProxy,
} from "./shared.js";
import { detectWhatsAppLegacyStateMigrations } from "./state-migrations.js";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

const loadWhatsAppDirectoryConfig = createLazyRuntimeModule(() => import("./directory-config.js"));
const loadWhatsAppChannelReactAction = createLazyRuntimeModule(
  () => import("./channel-react-action.js"),
);

function parseWhatsAppExplicitTarget(raw: string) {
  const normalized = normalizeWhatsAppTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    chatType: isWhatsAppGroupJid(normalized) ? ("group" as const) : ("direct" as const),
    to: normalized,
  };
}

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> =
  createChatChannelPlugin<ResolvedWhatsAppAccount>({
    base: {
      ...createWhatsAppPluginBase({
        groups: {
          resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
          resolveRequireMention: resolveWhatsAppGroupRequireMention,
          resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
        },
        isConfigured: async (account) =>
          await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir),
        setup: whatsappSetupAdapter,
        setupWizard: whatsappSetupWizardProxy,
      }),
      actions: {
        describeMessageTool: ({ cfg, accountId }) =>
          describeWhatsAppMessageActions({ accountId, cfg }),
        handleAction: async ({ action, params, cfg, accountId, toolContext }) =>
          await (
            await loadWhatsAppChannelReactAction()
          ).handleWhatsAppReactAction({
            accountId,
            action,
            cfg,
            params,
            toolContext,
          }),
        supportsAction: ({ action }) => action === "react",
      },
      agentPrompt: {
        reactionGuidance: ({ cfg, accountId }) => {
          const level = resolveWhatsAppAgentReactionGuidance({
            accountId: accountId ?? undefined,
            cfg,
          });
          return level ? { channelLabel: "WhatsApp", level } : undefined;
        },
      },
      agentTools: () => [createWhatsAppLoginTool()],
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "whatsapp",
        normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
        resolveAccount: resolveWhatsAppAccount,
        resolveDmAllowFrom: (account) => account.allowFrom,
        resolveDmPolicy: (account) => account.dmPolicy,
        resolveGroupAllowFrom: (account) => account.groupAllowFrom,
        resolveGroupPolicy: (account) => account.groupPolicy,
      }),
      approvalCapability: whatsappApprovalAuth,
      auth: {
        login: async ({ cfg, accountId, runtime, verbose }) => {
          const resolvedAccountId =
            accountId?.trim() ||
            whatsappPlugin.config.defaultAccountId?.(cfg) ||
            DEFAULT_ACCOUNT_ID;
          await (
            await loadWhatsAppChannelRuntime()
          ).loginWeb(Boolean(verbose), undefined, runtime, resolvedAccountId);
        },
      },
      commands: whatsappCommandPolicy,
      directory: {
        listGroups: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryGroupsFromConfig(params),
        listPeers: async (params) =>
          (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryPeersFromConfig(params),
        self: async ({ cfg, accountId }) => {
          const account = resolveWhatsAppAccount({ accountId, cfg });
          const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
          const id = e164 ?? jid;
          if (!id) {
            return null;
          }
          return {
            id,
            kind: "user",
            name: account.name,
            raw: { e164, jid },
          };
        },
      },
      gateway: {
        loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) =>
          await (
            await loadWhatsAppChannelRuntime()
          ).startWebLoginWithQr({
            accountId,
            force,
            timeoutMs,
            verbose,
          }),
        loginWithQrWait: async ({ accountId, timeoutMs }) =>
          await (await loadWhatsAppChannelRuntime()).waitForWebLogin({ accountId, timeoutMs }),
        logoutAccount: async ({ account, runtime }) => {
          const cleared = await (
            await loadWhatsAppChannelRuntime()
          ).logoutWeb({
            authDir: account.authDir,
            isLegacyAuthDir: account.isLegacyAuthDir,
            runtime,
          });
          return { cleared, loggedOut: cleared };
        },
        startAccount: async (ctx) => {
          const {account} = ctx;
          const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
          const identity = e164 ? e164 : (jid ? `jid ${jid}` : "unknown");
          ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
          return (await loadWhatsAppChannelRuntime()).monitorWebChannel(
            getWhatsAppRuntime().logging.shouldLogVerbose(),
            undefined,
            true,
            undefined,
            ctx.runtime,
            ctx.abortSignal,
            {
              accountId: account.accountId,
              statusSink: (next: WebChannelStatus) =>
                ctx.setStatus({ accountId: ctx.accountId, ...next }),
            },
          );
        },
      },
      heartbeat: {
        checkReady: async ({ cfg, accountId, deps }) =>
          await checkWhatsAppHeartbeatReady({ accountId: accountId ?? undefined, cfg, deps }),
        resolveRecipients: ({ cfg, opts }) => resolveWhatsAppHeartbeatRecipients(cfg, opts),
      },
      lifecycle: {
        detectLegacyStateMigrations: ({ oauthDir }) =>
          detectWhatsAppLegacyStateMigrations({ oauthDir }),
      },
      mentions: {
        stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx),
      },
      messaging: {
        inferTargetChatType: ({ to }) => parseWhatsAppExplicitTarget(to)?.chatType,
        normalizeTarget: normalizeWhatsAppMessagingTarget,
        parseExplicitTarget: ({ raw }) => parseWhatsAppExplicitTarget(raw),
        resolveOutboundSessionRoute: (params) => resolveWhatsAppOutboundSessionRoute(params),
        targetResolver: {
          hint: "<E.164|group JID>",
          looksLikeId: looksLikeWhatsAppTargetId,
        },
      },
      status: createAsyncComputedAccountStatusAdapter<ResolvedWhatsAppAccount>({
        buildChannelSummary: async ({ account, snapshot }) => {
          const authDir = account.authDir;
          const linked =
            typeof snapshot.linked === "boolean"
              ? snapshot.linked
              : authDir
                ? await (await loadWhatsAppChannelRuntime()).webAuthExists(authDir)
                : false;
          const authAgeMs =
            linked && authDir
              ? (await loadWhatsAppChannelRuntime()).getWebAuthAgeMs(authDir)
              : null;
          const self =
            linked && authDir
              ? (await loadWhatsAppChannelRuntime()).readWebSelfId(authDir)
              : { e164: null, jid: null };
          return {
            configured: linked,
            linked,
            authAgeMs,
            self,
            running: snapshot.running ?? false,
            connected: snapshot.connected ?? false,
            lastConnectedAt: snapshot.lastConnectedAt ?? null,
            lastDisconnect: snapshot.lastDisconnect ?? null,
            reconnectAttempts: snapshot.reconnectAttempts,
            lastInboundAt: snapshot.lastInboundAt ?? snapshot.lastMessageAt ?? null,
            lastMessageAt: snapshot.lastMessageAt ?? null,
            lastEventAt: snapshot.lastEventAt ?? null,
            lastError: snapshot.lastError ?? null,
            healthState: snapshot.healthState ?? undefined,
          };
        },
        collectStatusIssues: collectWhatsAppStatusIssues,
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastInboundAt: null,
          lastMessageAt: null,
          lastEventAt: null,
          healthState: "stopped",
        }),
        logSelfId: ({ account, runtime, includeChannelPrefix }) => {
          void loadWhatsAppChannelRuntime().then((runtimeExports) =>
            runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix),
          );
        },
        resolveAccountSnapshot: async ({ account, runtime }) => {
          const linked = await (await loadWhatsAppChannelRuntime()).webAuthExists(account.authDir);
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: true,
            extra: {
              linked,
              connected: runtime?.connected ?? false,
              reconnectAttempts: runtime?.reconnectAttempts,
              lastConnectedAt: runtime?.lastConnectedAt ?? null,
              lastDisconnect: runtime?.lastDisconnect ?? null,
              lastInboundAt: runtime?.lastInboundAt ?? runtime?.lastMessageAt ?? null,
              lastMessageAt: runtime?.lastMessageAt ?? null,
              lastEventAt: runtime?.lastEventAt ?? null,
              healthState: runtime?.healthState ?? undefined,
              dmPolicy: account.dmPolicy,
              allowFrom: account.allowFrom,
            },
          };
        },
        resolveAccountState: ({ configured }) => (configured ? "linked" : "not linked"),
      }),
    },
    outbound: whatsappChannelOutbound,
    pairing: {
      idLabel: "whatsappSenderId",
    },
  });
