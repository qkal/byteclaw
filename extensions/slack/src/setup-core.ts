import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  type ChannelSetupAdapter,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowlistSetupWizardProxy,
  createEnvPatchedAccountSetupAdapter,
  createLegacyCompatChannelDmPolicy,
  createStandardChannelSetupStatus,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { inspectSlackAccount } from "./account-inspect.js";
import { resolveSlackAccount } from "./accounts.js";
import {
  buildSlackSetupLines,
  SLACK_CHANNEL as channel,
  isSlackSetupAccountConfigured,
  setSlackChannelAllowlist,
} from "./shared.js";

function enableSlackAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  return patchChannelConfigForAccount({
    accountId,
    cfg,
    channel,
    patch: { enabled: true },
  });
}

function hasSlackInteractiveRepliesConfig(cfg: OpenClawConfig, accountId: string): boolean {
  const {capabilities} = resolveSlackAccount({ accountId, cfg }).config;
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => normalizeLowercaseStringOrEmpty(String(entry)) === "interactivereplies",
    );
  }
  if (!capabilities || typeof capabilities !== "object") {
    return false;
  }
  return "interactiveReplies" in capabilities;
}

function setSlackInteractiveReplies(
  cfg: OpenClawConfig,
  accountId: string,
  interactiveReplies: boolean,
): OpenClawConfig {
  const {capabilities} = resolveSlackAccount({ accountId, cfg }).config;
  const nextCapabilities = Array.isArray(capabilities)
    ? (interactiveReplies
      ? [...new Set([...capabilities, "interactiveReplies"])]
      : capabilities.filter(
          (entry) => normalizeLowercaseStringOrEmpty(String(entry)) !== "interactivereplies",
        ))
    : {
        ...((capabilities && typeof capabilities === "object" ? capabilities : {}) as Record<
          string,
          unknown
        >),
        interactiveReplies,
      };
  return patchChannelConfigForAccount({
    accountId,
    cfg,
    channel,
    patch: { capabilities: nextCapabilities },
  });
}

function createSlackTokenCredential(params: {
  inputKey: "botToken" | "appToken";
  providerHint: "slack-bot" | "slack-app";
  credentialLabel: string;
  preferredEnvVar: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN";
  keepPrompt: string;
  inputPrompt: string;
}) {
  return {
    allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
    applySet: ({
      cfg,
      accountId,
      value,
    }: {
      cfg: OpenClawConfig;
      accountId: string;
      value: unknown;
    }) =>
      patchChannelConfigForAccount({
        accountId,
        cfg,
        channel,
        patch: {
          enabled: true,
          [params.inputKey]: value,
        },
      }),
    applyUseEnv: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
      enableSlackAccount(cfg, accountId),
    credentialLabel: params.credentialLabel,
    envPrompt: `${params.preferredEnvVar} detected. Use env var?`,
    inputKey: params.inputKey,
    inputPrompt: params.inputPrompt,
    inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
      const resolved = resolveSlackAccount({ accountId, cfg });
      const configuredValue =
        params.inputKey === "botToken" ? resolved.config.botToken : resolved.config.appToken;
      const resolvedValue = params.inputKey === "botToken" ? resolved.botToken : resolved.appToken;
      return {
        accountConfigured: Boolean(resolvedValue) || hasConfiguredSecretInput(configuredValue),
        envValue:
          accountId === DEFAULT_ACCOUNT_ID
            ? normalizeOptionalString(process.env[params.preferredEnvVar])
            : undefined,
        hasConfiguredValue: hasConfiguredSecretInput(configuredValue),
        resolvedValue: normalizeOptionalString(resolvedValue),
      };
    },
    keepPrompt: params.keepPrompt,
    preferredEnvVar: params.preferredEnvVar,
    providerHint: params.providerHint,
  };
}

export const slackSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  buildPatch: (input) => ({
    ...(input.botToken ? { botToken: input.botToken } : {}),
    ...(input.appToken ? { appToken: input.appToken } : {}),
  }),
  channelKey: channel,
  defaultAccountOnlyEnvError: "Slack env tokens can only be used for the default account.",
  hasCredentials: (input) => Boolean(input.botToken && input.appToken),
  missingCredentialError: "Slack requires --bot-token and --app-token (or --use-env).",
});

export function createSlackSetupWizardBase(handlers: {
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
  resolveAllowFromEntries: NonNullable<
    NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
  >;
  resolveGroupAllowlist: NonNullable<
    NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
  >;
}) {
  const slackDmPolicy: ChannelSetupDmPolicy = createLegacyCompatChannelDmPolicy({
    channel,
    label: "Slack",
    promptAllowFrom: handlers.promptAllowFrom,
  });

  return {
    allowFrom: createAccountScopedAllowFromSection({
      channel,
      credentialInputKey: "botToken",
      helpLines: [
        "Allowlist Slack DMs by username (we resolve to user ids).",
        "Examples:",
        "- U12345678",
        "- @alice",
        "Multiple entries: comma-separated.",
        `Docs: ${formatDocsLink("/slack", "slack")}`,
      ],
      helpTitle: "Slack allowlist",
      invalidWithoutCredentialNote: "Slack token missing; use user ids (or mention form) only.",
      message: "Slack allowFrom (usernames or ids)",
      parseId: (value: string) =>
        parseMentionOrPrefixedId({
          value,
          mentionPattern: /^<@([A-Z0-9]+)>$/i,
          prefixPattern: /^(slack:|user:)/i,
          idPattern: /^[A-Z][A-Z0-9]+$/i,
          normalizeId: (id) => id.toUpperCase(),
        }),
      placeholder: "@alice, U12345678",
      resolveEntries: handlers.resolveAllowFromEntries,
    }),
    channel,
    credentials: [
      createSlackTokenCredential({
        credentialLabel: "Slack bot token",
        inputKey: "botToken",
        inputPrompt: "Enter Slack bot token (xoxb-...)",
        keepPrompt: "Slack bot token already configured. Keep it?",
        preferredEnvVar: "SLACK_BOT_TOKEN",
        providerHint: "slack-bot",
      }),
      createSlackTokenCredential({
        credentialLabel: "Slack app token",
        inputKey: "appToken",
        inputPrompt: "Enter Slack app token (xapp-...)",
        keepPrompt: "Slack app token already configured. Keep it?",
        preferredEnvVar: "SLACK_APP_TOKEN",
        providerHint: "slack-app",
      }),
    ],
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
    dmPolicy: slackDmPolicy,
    envShortcut: {
      apply: ({ cfg, accountId }) => enableSlackAccount(cfg, accountId),
      isAvailable: ({ cfg, accountId }) =>
        accountId === DEFAULT_ACCOUNT_ID &&
        Boolean(process.env.SLACK_BOT_TOKEN?.trim()) &&
        Boolean(process.env.SLACK_APP_TOKEN?.trim()) &&
        !isSlackSetupAccountConfigured(resolveSlackAccount({ accountId, cfg })),
      preferredEnvVar: "SLACK_BOT_TOKEN",
      prompt: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected. Use env vars?",
    },
    finalize: async ({ cfg, accountId, options, prompter }) => {
      if (hasSlackInteractiveRepliesConfig(cfg, accountId)) {
        return;
      }
      if (options?.quickstartDefaults) {
        return {
          cfg: setSlackInteractiveReplies(cfg, accountId, true),
        };
      }
      const enableInteractiveReplies = await prompter.confirm({
        initialValue: true,
        message: "Enable Slack interactive replies (buttons/selects) for agent responses?",
      });
      return {
        cfg: setSlackInteractiveReplies(cfg, accountId, enableInteractiveReplies),
      };
    },
    groupAccess: createAccountScopedGroupAccessSection({
      applyAllowlist: ({
        cfg,
        accountId,
        resolved,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        resolved: unknown;
      }) => setSlackChannelAllowlist(cfg, accountId, resolved as string[]),
      channel,
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(resolveSlackAccount({ cfg, accountId }).config.channels ?? {})
          .filter(([, value]) => value?.enabled !== false)
          .map(([key]) => key),
      currentPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        resolveSlackAccount({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      fallbackResolved: (entries) => entries,
      label: "Slack channels",
      placeholder: "#general, #private, C123",
      resolveAllowlist: handlers.resolveGroupAllowlist,
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(resolveSlackAccount({ cfg, accountId }).config.channels),
    }),
    introNote: {
      lines: buildSlackSetupLines(),
      shouldShow: ({ cfg, accountId }) =>
        !isSlackSetupAccountConfigured(resolveSlackAccount({ accountId, cfg })),
      title: "Slack socket mode tokens",
    },
    status: createStandardChannelSetupStatus({
      channelLabel: "Slack",
      configuredHint: "configured",
      configuredLabel: "configured",
      configuredScore: 2,
      resolveConfigured: ({ cfg, accountId }) => inspectSlackAccount({ cfg, accountId }).configured,
      unconfiguredHint: "needs tokens",
      unconfiguredLabel: "needs tokens",
      unconfiguredScore: 1,
    }),
  } satisfies ChannelSetupWizard;
}
export function createSlackSetupWizardProxy(
  loadWizard: () => Promise<{ slackSetupWizard: ChannelSetupWizard }>,
) {
  return createAllowlistSetupWizardProxy({
    createBase: createSlackSetupWizardBase,
    fallbackResolvedGroupAllowlist: (entries) => entries,
    loadWizard: async () => (await loadWizard()).slackSetupWizard,
  });
}
