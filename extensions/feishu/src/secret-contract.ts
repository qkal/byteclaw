import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
  normalizeSecretStringValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.feishu.accounts.*.appSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.feishu.accounts.*.appSecret",
    secretShape: "secret_input",
    targetType: "channels.feishu.accounts.*.appSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.feishu.accounts.*.encryptKey",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.feishu.accounts.*.encryptKey",
    secretShape: "secret_input",
    targetType: "channels.feishu.accounts.*.encryptKey",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.feishu.accounts.*.verificationToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.feishu.accounts.*.verificationToken",
    secretShape: "secret_input",
    targetType: "channels.feishu.accounts.*.verificationToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.feishu.appSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.feishu.appSecret",
    secretShape: "secret_input",
    targetType: "channels.feishu.appSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.feishu.encryptKey",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.feishu.encryptKey",
    secretShape: "secret_input",
    targetType: "channels.feishu.encryptKey",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.feishu.verificationToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.feishu.verificationToken",
    secretShape: "secret_input",
    targetType: "channels.feishu.verificationToken",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "feishu");
  if (!resolved) {
    return;
  }
  const { channel: feishu, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    accountInactiveReason: "Feishu account is disabled.",
    channel: feishu,
    channelKey: "feishu",
    context: params.context,
    defaults: params.defaults,
    field: "appSecret",
    surface,
    topInactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
  });
  const baseConnectionMode =
    normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
  const resolveAccountMode = (account: Record<string, unknown>) =>
    hasOwnProperty(account, "connectionMode")
      ? normalizeSecretStringValue(account.connectionMode)
      : baseConnectionMode;
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
    accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
    channel: feishu,
    channelKey: "feishu",
    context: params.context,
    defaults: params.defaults,
    field: "encryptKey",
    surface,
    topInactiveReason: "no enabled Feishu webhook-mode surface inherits this top-level encryptKey.",
    topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "encryptKey") &&
      resolveAccountMode(account) === "webhook",
  });
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "webhook",
    accountInactiveReason: "Feishu account is disabled or not running in webhook mode.",
    channel: feishu,
    channelKey: "feishu",
    context: params.context,
    defaults: params.defaults,
    field: "verificationToken",
    surface,
    topInactiveReason:
      "no enabled Feishu webhook-mode surface inherits this top-level verificationToken.",
    topLevelActiveWithoutAccounts: baseConnectionMode === "webhook",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "verificationToken") &&
      resolveAccountMode(account) === "webhook",
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
