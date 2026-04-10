import { Type } from "@sinclair/typebox";
import { createMessageToolButtonsSchema } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { mattermostApprovalAuth } from "./approval-auth.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  createAccountStatusSink,
} from "./channel-api.js";
import {
  describeMattermostAccount,
  isMattermostConfigured,
  mattermostConfigAdapter,
  mattermostMeta as meta,
  normalizeMattermostAllowEntry as normalizeAllowEntry,
} from "./channel-config-shared.js";
import { MattermostChannelConfigSchema } from "./config-surface.js";
import { mattermostDoctor } from "./doctor.js";
import { resolveMattermostGroupRequireMention } from "./group-mentions.js";
import {
  type ResolvedMattermostAccount,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode,
} from "./mattermost/accounts.js";
import type { MattermostSlashCommandConfig } from "./mattermost/slash-commands.js";
import { looksLikeMattermostTargetId, normalizeMattermostMessagingTarget } from "./normalize.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";
import { mattermostSetupAdapter } from "./setup-core.js";
import { mattermostSetupWizard } from "./setup-surface.js";
import type { MattermostConfig } from "./types.js";

const loadMattermostChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const DEFAULT_SLASH_CALLBACK_PATH = "/api/channels/mattermost/command";

function collectMattermostSlashCallbackPaths(
  raw?: Partial<MattermostSlashCommandConfig>,
): string[] {
  const callbackPath = (() => {
    const trimmed = raw?.callbackPath?.trim();
    if (!trimmed) {
      return DEFAULT_SLASH_CALLBACK_PATH;
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  })();
  const callbackUrl = raw?.callbackUrl?.trim();
  const paths = new Set<string>([callbackPath]);
  if (callbackUrl) {
    try {
      const { pathname } = new URL(callbackUrl);
      if (pathname) {
        paths.add(pathname);
      }
    } catch {
      // Keep the normalized callback path when the configured URL is invalid.
    }
  }
  return [...paths];
}

const mattermostSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedMattermostAccount>({
  channelKey: "mattermost",
  groupAllowFromPath: "channels.mattermost.groupAllowFrom",
  groupPolicyPath: "channels.mattermost.groupPolicy",
  normalizeDmEntry: (raw) => normalizeAllowEntry(raw),
  openScope: "any member",
  policyPathSuffix: "dmPolicy",
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "Mattermost channels",
});

function describeMattermostMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = (
    accountId
      ? [resolveMattermostAccount({ accountId, cfg })]
      : listMattermostAccountIds(cfg).map((listedAccountId) =>
          resolveMattermostAccount({ accountId: listedAccountId, cfg }),
        )
  )
    .filter((account) => account.enabled)
    .filter((account) => Boolean(account.botToken?.trim() && account.baseUrl?.trim()));

  const actions: ChannelMessageActionName[] = [];

  if (enabledAccounts.length > 0) {
    actions.push("send");
  }

  const actionsConfig = cfg.channels?.mattermost?.actions as { reactions?: boolean } | undefined;
  const baseReactions = actionsConfig?.reactions;
  const hasReactionCapableAccount = enabledAccounts.some((account) => {
    const accountActions = account.config.actions as { reactions?: boolean } | undefined;
    return accountActions?.reactions ?? baseReactions ?? true;
  });
  if (hasReactionCapableAccount) {
    actions.push("react");
  }

  return {
    actions,
    capabilities: enabledAccounts.length > 0 ? ["buttons"] : [],
    schema:
      enabledAccounts.length > 0
        ? {
            properties: {
              buttons: Type.Optional(createMessageToolButtonsSchema()),
            },
          }
        : null,
  };
}

const mattermostMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeMattermostMessageTool,
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "react") {
      const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
      const mattermostConfig = cfg.channels?.mattermost as MattermostConfig | undefined;
      const account = resolveMattermostAccount({ accountId: resolvedAccountId, cfg });
      const reactionsEnabled =
        account.config.actions?.reactions ?? mattermostConfig?.actions?.reactions ?? true;
      if (!reactionsEnabled) {
        throw new Error("Mattermost reactions are disabled in config");
      }

      const { postId, emojiName, remove } = parseMattermostReactActionParams(params);
      if (remove) {
        const result = await (
          await loadMattermostChannelRuntime()
        ).removeMattermostReaction({
          accountId: resolvedAccountId,
          cfg,
          emojiName,
          postId,
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        return {
          content: [
            { text: `Removed reaction :${emojiName}: from ${postId}`, type: "text" as const },
          ],
          details: {},
        };
      }

      const result = await (
        await loadMattermostChannelRuntime()
      ).addMattermostReaction({
        accountId: resolvedAccountId,
        cfg,
        emojiName,
        postId,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      return {
        content: [{ text: `Reacted with :${emojiName}: on ${postId}`, type: "text" as const }],
        details: {},
      };
    }

    if (action !== "send") {
      throw new Error(`Unsupported Mattermost action: ${action}`);
    }

    // Send action with optional interactive buttons
    const to =
      typeof params.to === "string"
        ? params.to.trim()
        : typeof params.target === "string"
          ? params.target.trim()
          : "";
    if (!to) {
      throw new Error("Mattermost send requires a target (to).");
    }

    const message = typeof params.message === "string" ? params.message : "";
    // Match the shared runner semantics: trim empty reply IDs away before
    // Falling back from replyToId to replyTo on direct plugin calls.
    const replyToId =
      normalizeOptionalString(params.replyToId) ?? normalizeOptionalString(params.replyTo);
    const resolvedAccountId = accountId || undefined;

    const mediaUrl =
      typeof params.media === "string" ? params.media.trim() || undefined : undefined;

    const result = await (
      await loadMattermostChannelRuntime()
    ).sendMessageMattermost(to, message, {
      accountId: resolvedAccountId,
      attachmentText: typeof params.attachmentText === "string" ? params.attachmentText : undefined,
      buttons: Array.isArray(params.buttons) ? params.buttons : undefined,
      mediaUrl,
      replyToId,
    });

    return {
      content: [
        {
          text: JSON.stringify({
            ok: true,
            channel: "mattermost",
            messageId: result.messageId,
            channelId: result.channelId,
          }),
          type: "text" as const,
        },
      ],
      details: {},
    };
  },
  supportsAction: ({ action }) => action === "send" || action === "react",
};

function parseMattermostReactActionParams(params: Record<string, unknown>): {
  postId: string;
  emojiName: string;
  remove: boolean;
} {
  const postId =
    normalizeOptionalString(params.messageId) ?? normalizeOptionalString(params.postId);
  if (!postId) {
    throw new Error("Mattermost react requires messageId (post id)");
  }

  const emojiName = normalizeOptionalString(params.emoji)?.replace(/^:+|:+$/g, "");
  if (!emojiName) {
    throw new Error("Mattermost react requires emoji");
  }

  return {
    emojiName,
    postId,
    remove: params.remove === true,
  };
}

export const mattermostPlugin: ChannelPlugin<ResolvedMattermostAccount> = createChatChannelPlugin({
  base: {
    actions: mattermostMessageActions,
    approvalCapability: mattermostApprovalAuth,
    capabilities: {
      chatTypes: ["direct", "channel", "group", "thread"],
      media: true,
      nativeCommands: true,
      reactions: true,
      threads: true,
    },
    config: {
      ...mattermostConfigAdapter,
      describeAccount: describeMattermostAccount,
      isConfigured: isMattermostConfigured,
    },
    configSchema: MattermostChannelConfigSchema,
    directory: createChannelDirectoryAdapter({
      listGroups: async (params) =>
        (await loadMattermostChannelRuntime()).listMattermostDirectoryGroups(params),
      listGroupsLive: async (params) =>
        (await loadMattermostChannelRuntime()).listMattermostDirectoryGroups(params),
      listPeers: async (params) =>
        (await loadMattermostChannelRuntime()).listMattermostDirectoryPeers(params),
      listPeersLive: async (params) =>
        (await loadMattermostChannelRuntime()).listMattermostDirectoryPeers(params),
    }),
    doctor: mattermostDoctor,
    gateway: {
      resolveGatewayAuthBypassPaths: ({ cfg }) => {
        const base = cfg.channels?.mattermost;
        const callbackPaths = new Set(
          collectMattermostSlashCallbackPaths(
            base?.commands as Partial<MattermostSlashCommandConfig> | undefined,
          ).filter(
            (path) =>
              path === "/api/channels/mattermost/command" ||
              path.startsWith("/api/channels/mattermost/"),
          ),
        );
        const accounts = base?.accounts ?? {};
        for (const account of Object.values(accounts)) {
          const accountConfig =
            account && typeof account === "object" && !Array.isArray(account)
              ? (account as {
                  commands?: Parameters<typeof collectMattermostSlashCallbackPaths>[0];
                })
              : undefined;
          for (const path of collectMattermostSlashCallbackPaths(accountConfig?.commands)) {
            if (
              path === "/api/channels/mattermost/command" ||
              path.startsWith("/api/channels/mattermost/")
            ) {
              callbackPaths.add(path);
            }
          }
        }
        return [...callbackPaths];
      },
      startAccount: async (ctx) => {
        const { account } = ctx;
        const statusSink = createAccountStatusSink({
          accountId: ctx.accountId,
          setStatus: ctx.setStatus,
        });
        statusSink({
          baseUrl: account.baseUrl,
          botTokenSource: account.botTokenSource,
        });
        ctx.log?.info(`[${account.accountId}] starting channel`);
        return (await loadMattermostChannelRuntime()).monitorMattermostProvider({
          abortSignal: ctx.abortSignal,
          accountId: account.accountId,
          baseUrl: account.baseUrl ?? undefined,
          botToken: account.botToken ?? undefined,
          config: ctx.cfg,
          runtime: ctx.runtime,
          statusSink,
        });
      },
    },
    groups: {
      resolveRequireMention: resolveMattermostGroupRequireMention,
    },
    id: "mattermost",
    messaging: {
      defaultMarkdownTableMode: "off",
      normalizeTarget: normalizeMattermostMessagingTarget,
      resolveOutboundSessionRoute: (params) => resolveMattermostOutboundSessionRoute(params),
      targetResolver: {
        hint: "<channelId|user:ID|channel:ID>",
        looksLikeId: looksLikeMattermostTargetId,
        resolveTarget: async ({ cfg, accountId, input }) => {
          const resolved = await (
            await loadMattermostChannelRuntime()
          ).resolveMattermostOpaqueTarget({
            accountId,
            cfg,
            input,
          });
          if (!resolved) {
            return null;
          }
          return {
            kind: resolved.kind,
            source: "directory",
            to: resolved.to,
          };
        },
      },
    },
    meta: {
      ...meta,
    },
    reload: { configPrefixes: ["channels.mattermost"] },
    secrets: {
      collectRuntimeConfigAssignments,
      secretTargetRegistryEntries,
    },
    setup: mattermostSetupAdapter,
    setupWizard: mattermostSetupWizard,
    status: createComputedAccountStatusAdapter<ResolvedMattermostAccount>({
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          botTokenSource: snapshot.botTokenSource ?? "none",
          connected: snapshot.connected ?? false,
          baseUrl: snapshot.baseUrl ?? null,
        }),
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
        connected: false,
        lastConnectedAt: null,
        lastDisconnect: null,
      }),
      probeAccount: async ({ account, timeoutMs }) => {
        const token = account.botToken?.trim();
        const baseUrl = account.baseUrl?.trim();
        if (!token || !baseUrl) {
          return { ok: false, error: "bot token or baseUrl missing" };
        }
        return await (
          await loadMattermostChannelRuntime()
        ).probeMattermost(baseUrl, token, timeoutMs, isPrivateNetworkOptInEnabled(account.config));
      },
      resolveAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.botToken && account.baseUrl),
        extra: {
          botTokenSource: account.botTokenSource,
          baseUrl: account.baseUrl,
          connected: runtime?.connected ?? false,
          lastConnectedAt: runtime?.lastConnectedAt ?? null,
          lastDisconnect: runtime?.lastDisconnect ?? null,
        },
      }),
    }),
    streaming: {
      blockStreamingCoalesceDefaults: { idleMs: 1000, minChars: 1500 },
    },
  },
  outbound: {
    attachedResults: {
      channel: "mattermost",
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        replyToId,
        threadId,
      }) =>
        await (
          await loadMattermostChannelRuntime()
        ).sendMessageMattermost(to, text, {
          accountId: accountId ?? undefined,
          cfg,
          mediaLocalRoots,
          mediaUrl,
          replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
        }),
      sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
        await (
          await loadMattermostChannelRuntime()
        ).sendMessageMattermost(to, text, {
          accountId: accountId ?? undefined,
          cfg,
          replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
        }),
    },
    base: {
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      deliveryMode: "direct",
      resolveTarget: ({ to }) => {
        const trimmed = to?.trim();
        if (!trimmed) {
          return {
            error: new Error(
              "Delivering to Mattermost requires --to <channelId|@username|user:ID|channel:ID>",
            ),
            ok: false,
          };
        }
        return { ok: true, to: trimmed };
      },
      textChunkLimit: 4000,
    },
  },
  pairing: {
    text: {
      idLabel: "mattermostUserId",
      message: "OpenClaw: your access has been approved.",
      normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
      notify: createLoggedPairingApprovalNotifier(
        ({ id }) => `[mattermost] User ${id} approved for pairing`,
      ),
    },
  },
  security: mattermostSecurityAdapter,
  threading: {
    resolveReplyTransport: ({ threadId, replyToId }) => ({
      replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
      threadId,
    }),
    scopedAccountReplyToMode: {
      resolveAccount: (cfg, accountId) =>
        resolveMattermostAccount({
          accountId: accountId ?? resolveDefaultMattermostAccountId(cfg),
          cfg,
        }),
      resolveReplyToMode: (account, chatType) =>
        resolveMattermostReplyToMode(
          account,
          chatType === "direct" || chatType === "group" || chatType === "channel"
            ? chatType
            : "channel",
        ),
    },
  },
});
