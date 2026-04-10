import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.telegram.accounts.*.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.telegram.accounts.*.botToken",
    secretShape: "secret_input",
    targetType: "channels.telegram.accounts.*.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.telegram.accounts.*.webhookSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.telegram.accounts.*.webhookSecret",
    secretShape: "secret_input",
    targetType: "channels.telegram.accounts.*.webhookSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.telegram.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.telegram.botToken",
    secretShape: "secret_input",
    targetType: "channels.telegram.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.telegram.webhookSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.telegram.webhookSecret",
    secretShape: "secret_input",
    targetType: "channels.telegram.webhookSecret",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "telegram");
  if (!resolved) {
    return;
  }
  const { channel: telegram, surface } = resolved;
  const baseTokenFile = normalizeOptionalString(telegram.tokenFile) ?? "";
  const accountTokenFile = (account: Record<string, unknown>) =>
    normalizeOptionalString(account.tokenFile) ?? "";
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && accountTokenFile(account).length === 0,
    accountInactiveReason: "Telegram account is disabled or tokenFile is configured.",
    channel: telegram,
    channelKey: "telegram",
    context: params.context,
    defaults: params.defaults,
    field: "botToken",
    surface,
    topInactiveReason:
      "no enabled Telegram surface inherits this top-level botToken (tokenFile is configured).",
    topLevelActiveWithoutAccounts: baseTokenFile.length === 0,
    topLevelInheritedAccountActive: ({ account, enabled }) => {
      if (!enabled || baseTokenFile.length > 0) {
        return false;
      }
      const accountBotTokenConfigured = hasConfiguredSecretInputValue(
        account.botToken,
        params.defaults,
      );
      return !accountBotTokenConfigured && accountTokenFile(account).length === 0;
    },
  });
  const baseWebhookUrl = normalizeOptionalString(telegram.webhookUrl) ?? "";
  const accountWebhookUrl = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "webhookUrl")
      ? (normalizeOptionalString(account.webhookUrl) ?? "")
      : baseWebhookUrl;
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
    accountInactiveReason:
      "Telegram account is disabled or webhook mode is not active for this account.",
    channel: telegram,
    channelKey: "telegram",
    context: params.context,
    defaults: params.defaults,
    field: "webhookSecret",
    surface,
    topInactiveReason:
      "no enabled Telegram webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
    topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "webhookSecret") && accountWebhookUrl(account).length > 0,
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
