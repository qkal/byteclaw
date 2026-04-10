import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  buildWebhookChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { type ResolvedNextcloudTalkAccount, resolveNextcloudTalkAccount } from "./accounts.js";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";
import { type ChannelPlugin, DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "./channel-api.js";
import {
  nextcloudTalkConfigAdapter,
  nextcloudTalkPairingTextAdapter,
  nextcloudTalkSecurityAdapter,
} from "./channel.adapters.js";
import { NextcloudTalkConfigSchema } from "./config-schema.js";
import { nextcloudTalkDoctor } from "./doctor.js";
import { nextcloudTalkGatewayAdapter } from "./gateway.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
} from "./normalize.js";
import { resolveNextcloudTalkGroupToolPolicy } from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";
import { nextcloudTalkSetupAdapter } from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const meta = {
  aliases: ["nc-talk", "nc"],
  blurb: "Self-hosted chat via Nextcloud Talk webhook bots.",
  docsLabel: "nextcloud-talk",
  docsPath: "/channels/nextcloud-talk",
  id: "nextcloud-talk",
  label: "Nextcloud Talk",
  order: 65,
  quickstartAllowFrom: true,
  selectionLabel: "Nextcloud Talk (self-hosted)",
};

const collectNextcloudTalkSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedNextcloudTalkAccount>({
    noRouteAllowlist: {
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      routeAllowlistPath: "channels.nextcloud-talk.rooms",
      routeScope: "room",
      surface: "Nextcloud Talk rooms",
    },
    providerConfigPresent: (cfg) =>
      (cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.rooms) && Object.keys(account.config.rooms ?? {}).length > 0,
    restrictSenders: {
      groupAllowFromPath: "channels.nextcloud-talk.groupAllowFrom",
      groupPolicyPath: "channels.nextcloud-talk.groupPolicy",
      openScope: "any member in allowed rooms",
      surface: "Nextcloud Talk rooms",
    },
  });

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> =
  createChatChannelPlugin({
    base: {
      approvalCapability: nextcloudTalkApprovalAuth,
      capabilities: {
        blockStreaming: true,
        chatTypes: ["direct", "group"],
        media: true,
        nativeCommands: false,
        reactions: true,
        threads: false,
      },
      config: {
        ...nextcloudTalkConfigAdapter,
        describeAccount: (account) =>
          describeWebhookAccountSnapshot({
            account,
            configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
            extra: {
              baseUrl: account.baseUrl ? "[set]" : "[missing]",
              secretSource: account.secretSource,
            },
          }),
        isConfigured: (account) => Boolean(account.secret?.trim() && account.baseUrl?.trim()),
      },
      configSchema: buildChannelConfigSchema(NextcloudTalkConfigSchema),
      doctor: nextcloudTalkDoctor,
      gateway: nextcloudTalkGatewayAdapter,
      groups: {
        resolveRequireMention: ({ cfg, accountId, groupId }) => {
          const account = resolveNextcloudTalkAccount({ accountId, cfg: cfg as CoreConfig });
          const {rooms} = account.config;
          if (!rooms || !groupId) {
            return true;
          }

          const roomConfig = rooms[groupId];
          if (roomConfig?.requireMention !== undefined) {
            return roomConfig.requireMention;
          }

          const wildcardConfig = rooms["*"];
          if (wildcardConfig?.requireMention !== undefined) {
            return wildcardConfig.requireMention;
          }

          return true;
        },
        resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy,
      },
      id: "nextcloud-talk",
      messaging: {
        normalizeTarget: normalizeNextcloudTalkMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveNextcloudTalkOutboundSessionRoute(params),
        targetResolver: {
          hint: "<roomToken>",
          looksLikeId: looksLikeNextcloudTalkTargetId,
        },
      },
      meta,
      reload: { configPrefixes: ["channels.nextcloud-talk"] },
      secrets: {
        collectRuntimeConfigAssignments,
        secretTargetRegistryEntries,
      },
      setup: nextcloudTalkSetupAdapter,
      setupWizard: nextcloudTalkSetupWizard,
      status: createComputedAccountStatusAdapter<ResolvedNextcloudTalkAccount>({
        buildChannelSummary: ({ snapshot }) =>
          buildWebhookChannelStatusSummary(snapshot, {
            secretSource: snapshot.secretSource ?? "none",
          }),
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: Boolean(account.secret?.trim() && account.baseUrl?.trim()),
          extra: {
            secretSource: account.secretSource,
            baseUrl: account.baseUrl ? "[set]" : "[missing]",
            mode: "webhook",
          },
        }),
      }),
    },
    outbound: {
      attachedResults: {
        channel: "nextcloud-talk",
        sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
          await sendMessageNextcloudTalk(
            to,
            mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text,
            {
              accountId: accountId ?? undefined,
              cfg: cfg as CoreConfig,
              replyTo: replyToId ?? undefined,
            },
          ),
        sendText: async ({ cfg, to, text, accountId, replyToId }) =>
          await sendMessageNextcloudTalk(to, text, {
            accountId: accountId ?? undefined,
            cfg: cfg as CoreConfig,
            replyTo: replyToId ?? undefined,
          }),
      },
      base: {
        chunker: (text, limit) =>
          getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown",
        deliveryMode: "direct",
        textChunkLimit: 4000,
      },
    },
    pairing: {
      text: {
        ...nextcloudTalkPairingTextAdapter,
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[nextcloud-talk] User ${id} approved for pairing`,
        ),
      },
    },
    security: {
      ...nextcloudTalkSecurityAdapter,
      collectWarnings: collectNextcloudTalkSecurityWarnings,
    },
  });
