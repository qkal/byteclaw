import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  type ChannelPlugin,
  buildChannelConfigSchema,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  createOpenProviderGroupPolicyWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { buildTokenChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createStaticReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { listResolvedDirectoryUserEntriesFromAllowFrom } from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
} from "openclaw/plugin-sdk/reply-payload";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  type ResolvedZaloAccount,
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "./accounts.js";
import { zaloMessageActions } from "./actions.js";
import { zaloApprovalAuth } from "./approval-auth.js";
import { ZaloConfigSchema } from "./config-schema.js";
import type { ZaloProbeResult } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveZaloOutboundSessionRoute } from "./session-route.js";
import { createZaloSetupWizardProxy, zaloSetupAdapter } from "./setup-core.js";
import { collectZaloStatusIssues } from "./status-issues.js";

const meta = {
  aliases: ["zl"],
  blurb: "Vietnam-focused messaging platform with Bot API.",
  docsLabel: "zalo",
  docsPath: "/channels/zalo",
  id: "zalo",
  label: "Zalo",
  order: 80,
  quickstartAllowFrom: true,
  selectionLabel: "Zalo (Bot API)",
};

function normalizeZaloMessagingTarget(raw: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(zalo|zl):/i, "").trim();
}

const loadZaloChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));
const zaloSetupWizard = createZaloSetupWizardProxy(
  async () => (await import("./setup-surface.js")).zaloSetupWizard,
);
const zaloTextChunkLimit = 2000;

const zaloRawSendResultAdapter = createRawChannelSendResultAdapter({
  channel: "zalo",
  sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) =>
    await (
      await loadZaloChannelRuntime()
    ).sendZaloText({
      accountId: accountId ?? undefined,
      cfg,
      mediaUrl,
      text,
      to,
    }),
  sendText: async ({ to, text, accountId, cfg }) =>
    await (
      await loadZaloChannelRuntime()
    ).sendZaloText({
      accountId: accountId ?? undefined,
      cfg,
      text,
      to,
    }),
});

const zaloConfigAdapter = createScopedChannelConfigAdapter<ResolvedZaloAccount>({
  clearBaseFields: ["botToken", "tokenFile", "name"],
  defaultAccountId: resolveDefaultZaloAccountId,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(zalo|zl):/i }),
  listAccountIds: listZaloAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
  resolveAllowFrom: (account: ResolvedZaloAccount) => account.config.allowFrom,
  sectionKey: "zalo",
});

const resolveZaloDmPolicy = createScopedDmSecurityResolver<ResolvedZaloAccount>({
  channelKey: "zalo",
  normalizeEntry: (raw) => raw.trim().replace(/^(zalo|zl):/i, ""),
  policyPathSuffix: "dmPolicy",
  resolveAllowFrom: (account) => account.config.allowFrom,
  resolvePolicy: (account) => account.config.dmPolicy,
});

const collectZaloSecurityWarnings = createOpenProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
  account: ResolvedZaloAccount;
}>({
  collect: ({ account, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const explicitGroupAllowFrom = mapAllowFromEntries(account.config.groupAllowFrom);
    const dmAllowFrom = mapAllowFromEntries(account.config.allowFrom);
    const effectiveAllowFrom =
      explicitGroupAllowFrom.length > 0 ? explicitGroupAllowFrom : dmAllowFrom;
    if (effectiveAllowFrom.length > 0) {
      return [
        buildOpenGroupPolicyRestrictSendersWarning({
          groupAllowFromPath: "channels.zalo.groupAllowFrom",
          groupPolicyPath: "channels.zalo.groupPolicy",
          openScope: "any member",
          surface: "Zalo groups",
        }),
      ];
    }
    return [
      buildOpenGroupPolicyWarning({
        openBehavior:
          "with no groupAllowFrom/allowFrom allowlist; any member can trigger (mention-gated)",
        remediation: 'Set channels.zalo.groupPolicy="allowlist" + channels.zalo.groupAllowFrom',
        surface: "Zalo groups",
      }),
    ];
  },
  providerConfigPresent: (cfg) => cfg.channels?.zalo !== undefined,
  resolveGroupPolicy: ({ account }) => account.config.groupPolicy,
});

export const zaloPlugin: ChannelPlugin<ResolvedZaloAccount, ZaloProbeResult> =
  createChatChannelPlugin({
    base: {
      actions: zaloMessageActions,
      approvalCapability: zaloApprovalAuth,
      capabilities: {
        blockStreaming: true,
        chatTypes: ["direct", "group"],
        media: true,
        nativeCommands: false,
        polls: false,
        reactions: false,
        threads: false,
      },
      config: {
        ...zaloConfigAdapter,
        describeAccount: (account): ChannelAccountSnapshot =>
          describeWebhookAccountSnapshot({
            account,
            configured: Boolean(account.token?.trim()),
            extra: {
              tokenSource: account.tokenSource,
            },
            mode: account.config.webhookUrl ? "webhook" : "polling",
          }),
        isConfigured: (account) => Boolean(account.token?.trim()),
      },
      configSchema: buildChannelConfigSchema(ZaloConfigSchema),
      directory: createChannelDirectoryAdapter({
        listGroups: async () => [],
        listPeers: async (params) =>
          listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedZaloAccount>({
            ...params,
            resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
            resolveAllowFrom: (account) => account.config.allowFrom,
            normalizeId: (entry) => entry.trim().replace(/^(zalo|zl):/i, ""),
          }),
      }),
      gateway: {
        startAccount: async (ctx) =>
          await (await loadZaloChannelRuntime()).startZaloGatewayAccount(ctx),
      },
      groups: {
        resolveRequireMention: () => true,
      },
      id: "zalo",
      messaging: {
        normalizeTarget: normalizeZaloMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveZaloOutboundSessionRoute(params),
        targetResolver: {
          hint: "<chatId>",
          looksLikeId: isNumericTargetId,
        },
      },
      meta,
      reload: { configPrefixes: ["channels.zalo"] },
      secrets: {
        collectRuntimeConfigAssignments,
        secretTargetRegistryEntries,
      },
      setup: zaloSetupAdapter,
      setupWizard: zaloSetupWizard,
      status: createComputedAccountStatusAdapter<ResolvedZaloAccount, ZaloProbeResult>({
        buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
        collectStatusIssues: collectZaloStatusIssues,
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        probeAccount: async ({ account, timeoutMs }) =>
          await (await loadZaloChannelRuntime()).probeZaloAccount({ account, timeoutMs }),
        resolveAccountSnapshot: ({ account }) => {
          const configured = Boolean(account.token?.trim());
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured,
            extra: {
              tokenSource: account.tokenSource,
              mode: account.config.webhookUrl ? "webhook" : "polling",
              dmPolicy: account.config.dmPolicy ?? "pairing",
            },
          };
        },
      }),
    },
    outbound: {
      chunker: chunkTextForOutbound,
      chunkerMode: "text",
      deliveryMode: "direct",
      sendPayload: async (ctx) =>
        await sendPayloadWithChunkedTextAndMedia({
          chunker: chunkTextForOutbound,
          ctx,
          emptyResult: createEmptyChannelResult("zalo"),
          sendMedia: (nextCtx) => zaloRawSendResultAdapter.sendMedia!(nextCtx),
          sendText: (nextCtx) => zaloRawSendResultAdapter.sendText!(nextCtx),
          textChunkLimit: zaloTextChunkLimit,
        }),
      textChunkLimit: zaloTextChunkLimit,
      ...zaloRawSendResultAdapter,
    },
    pairing: {
      text: {
        idLabel: "zaloUserId",
        message: "Your pairing request has been approved.",
        normalizeAllowEntry: (entry) => entry.trim().replace(/^(zalo|zl):/i, ""),
        notify: async (params) =>
          await (await loadZaloChannelRuntime()).notifyZaloPairingApproval(params),
      },
    },
    security: {
      collectWarnings: collectZaloSecurityWarnings,
      resolveDmPolicy: resolveZaloDmPolicy,
    },
    threading: {
      resolveReplyToMode: createStaticReplyToModeResolver("off"),
    },
  });
