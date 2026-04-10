import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectSecretInputAssignment,
  getChannelRecord,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.msteams.appPassword",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.msteams.appPassword",
    secretShape: "secret_input",
    targetType: "channels.msteams.appPassword",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const msteams = getChannelRecord(params.config, "msteams");
  if (!msteams) {
    return;
  }
  collectSecretInputAssignment({
    active: msteams.enabled !== false,
    apply: (value) => {
      msteams.appPassword = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    inactiveReason: "Microsoft Teams channel is disabled.",
    path: "channels.msteams.appPassword",
    value: msteams.appPassword,
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
