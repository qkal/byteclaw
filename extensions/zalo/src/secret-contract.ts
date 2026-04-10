import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.zalo.accounts.*.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.zalo.accounts.*.botToken",
    secretShape: "secret_input",
    targetType: "channels.zalo.accounts.*.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.zalo.accounts.*.webhookSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.zalo.accounts.*.webhookSecret",
    secretShape: "secret_input",
    targetType: "channels.zalo.accounts.*.webhookSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.zalo.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.zalo.botToken",
    secretShape: "secret_input",
    targetType: "channels.zalo.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.zalo.webhookSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.zalo.webhookSecret",
    secretShape: "secret_input",
    targetType: "channels.zalo.webhookSecret",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "zalo");
  if (!resolved) {
    return;
  }
  const { channel: zalo, surface } = resolved;
  collectConditionalChannelFieldAssignments({
    accountActive: ({ enabled }) => enabled,
    accountInactiveReason: "Zalo account is disabled.",
    channel: zalo,
    channelKey: "zalo",
    context: params.context,
    defaults: params.defaults,
    field: "botToken",
    surface,
    topInactiveReason: "no enabled Zalo surface inherits this top-level botToken.",
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "botToken"),
  });
  const baseWebhookUrl = typeof zalo.webhookUrl === "string" ? zalo.webhookUrl.trim() : "";
  const accountWebhookUrl = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "webhookUrl")
      ? typeof account.webhookUrl === "string"
        ? account.webhookUrl.trim()
        : ""
      : baseWebhookUrl;
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && accountWebhookUrl(account).length > 0,
    accountInactiveReason:
      "Zalo account is disabled or webhook mode is not active for this account.",
    channel: zalo,
    channelKey: "zalo",
    context: params.context,
    defaults: params.defaults,
    field: "webhookSecret",
    surface,
    topInactiveReason:
      "no enabled Zalo webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
    topLevelActiveWithoutAccounts: baseWebhookUrl.length > 0,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "webhookSecret") && accountWebhookUrl(account).length > 0,
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
