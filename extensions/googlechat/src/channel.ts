import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { googlechatMessageActions } from "./actions.js";
import { googleChatApprovalAuth } from "./approval-auth.js";
import {
  formatAllowFromEntry,
  googlechatDirectoryAdapter,
  googlechatGroupsAdapter,
  googlechatOutboundAdapter,
  googlechatPairingTextAdapter,
  googlechatSecurityAdapter,
  googlechatThreadingAdapter,
} from "./channel.adapters.js";
import {
  type ChannelMessageActionAdapter,
  type ChannelStatusIssue,
  DEFAULT_ACCOUNT_ID,
  GoogleChatConfigSchema,
  type ResolvedGoogleChatAccount,
  buildChannelConfigSchema,
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  listGoogleChatAccountIds,
  normalizeGoogleChatTarget,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "./channel.deps.runtime.js";
import { collectGoogleChatMutableAllowlistWarnings } from "./doctor.js";
import { startGoogleChatGatewayAccount } from "./gateway.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { googlechatSetupAdapter } from "./setup-core.js";
import { googlechatSetupWizard } from "./setup-surface.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

const meta = {
  aliases: ["gchat", "google-chat"],
  blurb: "Google Workspace Chat app with HTTP webhook.",
  detailLabel: "Google Chat",
  docsLabel: "googlechat",
  docsPath: "/channels/googlechat",
  id: "googlechat",
  label: "Google Chat",
  markdownCapable: true,
  order: 55,
  selectionLabel: "Google Chat (Chat API)",
  systemImage: "message.badge",
};

const googleChatConfigAdapter = createScopedChannelConfigAdapter<ResolvedGoogleChatAccount>({
  clearBaseFields: [
    "serviceAccount",
    "serviceAccountFile",
    "audienceType",
    "audience",
    "webhookPath",
    "webhookUrl",
    "botUser",
    "name",
  ],
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatAllowFromEntry,
    }),
  listAccountIds: listGoogleChatAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveGoogleChatAccount),
  resolveAllowFrom: (account: ResolvedGoogleChatAccount) => account.config.dm?.allowFrom,
  resolveDefaultTo: (account: ResolvedGoogleChatAccount) => account.config.defaultTo,
  sectionKey: "googlechat",
});

const googlechatActions: ChannelMessageActionAdapter = {
  describeMessageTool: (ctx) => googlechatMessageActions.describeMessageTool?.(ctx) ?? null,
  extractToolSend: (ctx) => googlechatMessageActions.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  },
};

export const googlechatPlugin = createChatChannelPlugin({
  base: {
    actions: googlechatActions,
    approvalCapability: googleChatApprovalAuth,
    capabilities: {
      blockStreaming: true,
      chatTypes: ["direct", "group", "thread"],
      media: true,
      nativeCommands: false,
      reactions: true,
      threads: true,
    },
    config: {
      ...googleChatConfigAdapter,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.credentialSource !== "none",
          extra: {
            credentialSource: account.credentialSource,
          },
        }),
      isConfigured: (account) => account.credentialSource !== "none",
    },
    configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
    directory: googlechatDirectoryAdapter,
    doctor: {
      collectMutableAllowlistWarnings: collectGoogleChatMutableAllowlistWarnings,
      dmAllowFromMode: "nestedOnly",
      groupAllowFromFallbackToAllowFrom: false,
      groupModel: "route",
      warnOnEmptyGroupSenderAllowlist: false,
    },
    gateway: {
      startAccount: startGoogleChatGatewayAccount,
    },
    groups: googlechatGroupsAdapter,
    id: "googlechat",
    messaging: {
      normalizeTarget: normalizeGoogleChatTarget,
      targetResolver: {
        hint: "<spaces/{space}|users/{user}>",
        looksLikeId: (raw, normalized) => {
          const value = normalized ?? raw.trim();
          return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
        },
      },
    },
    meta: { ...meta },
    reload: { configPrefixes: ["channels.googlechat"] },
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        const resolved = inputs.map((input) => {
          const normalized = normalizeGoogleChatTarget(input);
          if (!normalized) {
            return { input, note: "empty target", resolved: false };
          }
          if (kind === "user" && isGoogleChatUserTarget(normalized)) {
            return { id: normalized, input, resolved: true };
          }
          if (kind === "group" && isGoogleChatSpaceTarget(normalized)) {
            return { id: normalized, input, resolved: true };
          }
          return {
            input,
            note: "use spaces/{space} or users/{user}",
            resolved: false,
          };
        });
        return resolved;
      },
    },
    secrets: {
      collectRuntimeConfigAssignments,
      secretTargetRegistryEntries,
    },
    setup: googlechatSetupAdapter,
    setupWizard: googlechatSetupWizard,
    status: createComputedAccountStatusAdapter<ResolvedGoogleChatAccount>({
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          credentialSource: snapshot.credentialSource ?? "none",
          audienceType: snapshot.audienceType ?? null,
          audience: snapshot.audience ?? null,
          webhookPath: snapshot.webhookPath ?? null,
          webhookUrl: snapshot.webhookUrl ?? null,
        }),
      collectStatusIssues: (accounts): ChannelStatusIssue[] =>
        accounts.flatMap((entry) => {
          const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
          const enabled = entry.enabled !== false;
          const configured = entry.configured === true;
          if (!enabled || !configured) {
            return [];
          }
          const issues: ChannelStatusIssue[] = [];
          if (!entry.audience) {
            issues.push({
              channel: "googlechat",
              accountId,
              kind: "config",
              message: "Google Chat audience is missing (set channels.googlechat.audience).",
              fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
            });
          }
          if (!entry.audienceType) {
            issues.push({
              channel: "googlechat",
              accountId,
              kind: "config",
              message: "Google Chat audienceType is missing (app-url or project-number).",
              fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
            });
          }
          return issues;
        }),
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      probeAccount: async ({ account }) =>
        (await loadGoogleChatChannelRuntime()).probeGoogleChat(account),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.credentialSource !== "none",
        extra: {
          credentialSource: account.credentialSource,
          audienceType: account.config.audienceType,
          audience: account.config.audience,
          webhookPath: account.config.webhookPath,
          webhookUrl: account.config.webhookUrl,
          dmPolicy: account.config.dm?.policy ?? "pairing",
        },
      }),
    }),
    streaming: {
      blockStreamingCoalesceDefaults: { idleMs: 1000, minChars: 1500 },
    },
  },
  outbound: googlechatOutboundAdapter,
  pairing: {
    text: googlechatPairingTextAdapter,
  },
  security: googlechatSecurityAdapter,
  threading: googlechatThreadingAdapter,
});
