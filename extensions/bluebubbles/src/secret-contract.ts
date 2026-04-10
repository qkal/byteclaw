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
    id: "channels.bluebubbles.accounts.*.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.bluebubbles.accounts.*.password",
    secretShape: "secret_input",
    targetType: "channels.bluebubbles.accounts.*.password",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.bluebubbles.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.bluebubbles.password",
    secretShape: "secret_input",
    targetType: "channels.bluebubbles.password",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "bluebubbles");
  if (!resolved) {
    return;
  }
  const { channel: bluebubbles, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    accountInactiveReason: "BlueBubbles account is disabled.",
    channel: bluebubbles,
    channelKey: "bluebubbles",
    context: params.context,
    defaults: params.defaults,
    field: "password",
    surface,
    topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
