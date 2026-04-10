import {
  type ChannelAccountEntry,
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
    id: "channels.nextcloud-talk.accounts.*.apiPassword",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.nextcloud-talk.accounts.*.apiPassword",
    secretShape: "secret_input",
    targetType: "channels.nextcloud-talk.accounts.*.apiPassword",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.nextcloud-talk.accounts.*.botSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.nextcloud-talk.accounts.*.botSecret",
    secretShape: "secret_input",
    targetType: "channels.nextcloud-talk.accounts.*.botSecret",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.nextcloud-talk.apiPassword",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.nextcloud-talk.apiPassword",
    secretShape: "secret_input",
    targetType: "channels.nextcloud-talk.apiPassword",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.nextcloud-talk.botSecret",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.nextcloud-talk.botSecret",
    secretShape: "secret_input",
    targetType: "channels.nextcloud-talk.botSecret",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "nextcloud-talk");
  if (!resolved) {
    return;
  }
  const { channel: nextcloudTalk, surface } = resolved;
  const inheritsField =
    (field: string) =>
    ({ account, enabled }: ChannelAccountEntry) =>
      enabled && !hasOwnProperty(account, field);
  collectConditionalChannelFieldAssignments({
    accountActive: ({ enabled }) => enabled,
    accountInactiveReason: "Nextcloud Talk account is disabled.",
    channel: nextcloudTalk,
    channelKey: "nextcloud-talk",
    context: params.context,
    defaults: params.defaults,
    field: "botSecret",
    surface,
    topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level botSecret.",
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("botSecret"),
  });
  collectConditionalChannelFieldAssignments({
    accountActive: ({ enabled }) => enabled,
    accountInactiveReason: "Nextcloud Talk account is disabled.",
    channel: nextcloudTalk,
    channelKey: "nextcloud-talk",
    context: params.context,
    defaults: params.defaults,
    field: "apiPassword",
    surface,
    topInactiveReason: "no enabled Nextcloud Talk surface inherits this top-level apiPassword.",
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: inheritsField("apiPassword"),
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
