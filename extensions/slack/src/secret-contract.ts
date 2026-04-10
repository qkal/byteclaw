import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectConditionalChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  hasOwnProperty,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.accounts.*.appToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.accounts.*.appToken",
    secretShape: "secret_input",
    targetType: "channels.slack.accounts.*.appToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.accounts.*.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.accounts.*.botToken",
    secretShape: "secret_input",
    targetType: "channels.slack.accounts.*.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.accounts.*.signingSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.accounts.*.signingSecret",
    secretShape: "secret_input",
    targetType: "channels.slack.accounts.*.signingSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.accounts.*.userToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.accounts.*.userToken",
    secretShape: "secret_input",
    targetType: "channels.slack.accounts.*.userToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.appToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.appToken",
    secretShape: "secret_input",
    targetType: "channels.slack.appToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.botToken",
    secretShape: "secret_input",
    targetType: "channels.slack.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.signingSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.signingSecret",
    secretShape: "secret_input",
    targetType: "channels.slack.signingSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.slack.userToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.slack.userToken",
    secretShape: "secret_input",
    targetType: "channels.slack.userToken",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "slack");
  if (!resolved) {
    return;
  }
  const { channel: slack, surface } = resolved;
  const baseMode = slack.mode === "http" || slack.mode === "socket" ? slack.mode : "socket";
  const fields = ["botToken", "userToken"] as const;
  for (const field of fields) {
    collectSimpleChannelFieldAssignments({
      accountInactiveReason: "Slack account is disabled.",
      channel: slack,
      channelKey: "slack",
      context: params.context,
      defaults: params.defaults,
      field,
      surface,
      topInactiveReason: `no enabled account inherits this top-level Slack ${field}.`,
    });
  }
  const resolveAccountMode = (account: Record<string, unknown>) =>
    account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) !== "http",
    accountInactiveReason: "Slack account is disabled or not running in socket mode.",
    channel: slack,
    channelKey: "slack",
    context: params.context,
    defaults: params.defaults,
    field: "appToken",
    surface,
    topInactiveReason: "no enabled Slack socket-mode surface inherits this top-level appToken.",
    topLevelActiveWithoutAccounts: baseMode !== "http",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "appToken") && resolveAccountMode(account) !== "http",
  });
  collectConditionalChannelFieldAssignments({
    accountActive: ({ account, enabled }) => enabled && resolveAccountMode(account) === "http",
    accountInactiveReason: "Slack account is disabled or not running in HTTP mode.",
    channel: slack,
    channelKey: "slack",
    context: params.context,
    defaults: params.defaults,
    field: "signingSecret",
    surface,
    topInactiveReason: "no enabled Slack HTTP-mode surface inherits this top-level signingSecret.",
    topLevelActiveWithoutAccounts: baseMode === "http",
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled &&
      !hasOwnProperty(account, "signingSecret") &&
      resolveAccountMode(account) === "http",
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
