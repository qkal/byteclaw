import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.mattermost.accounts.*.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.mattermost.accounts.*.botToken",
    secretShape: "secret_input",
    targetType: "channels.mattermost.accounts.*.botToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.mattermost.botToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.mattermost.botToken",
    secretShape: "secret_input",
    targetType: "channels.mattermost.botToken",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "mattermost");
  if (!resolved) {
    return;
  }
  const { channel: mattermost, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    accountInactiveReason: "Mattermost account is disabled.",
    channel: mattermost,
    channelKey: "mattermost",
    context: params.context,
    defaults: params.defaults,
    field: "botToken",
    surface,
    topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
