import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  isBaseFieldActiveForChannelSurface,
  isEnabledFlag,
  isRecord,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.irc.accounts.*.nickserv.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.irc.accounts.*.nickserv.password",
    secretShape: "secret_input",
    targetType: "channels.irc.accounts.*.nickserv.password",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.irc.accounts.*.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.irc.accounts.*.password",
    secretShape: "secret_input",
    targetType: "channels.irc.accounts.*.password",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.irc.nickserv.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.irc.nickserv.password",
    secretShape: "secret_input",
    targetType: "channels.irc.nickserv.password",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.irc.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.irc.password",
    secretShape: "secret_input",
    targetType: "channels.irc.password",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "irc");
  if (!resolved) {
    return;
  }
  const { channel: irc, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    accountInactiveReason: "IRC account is disabled.",
    channel: irc,
    channelKey: "irc",
    context: params.context,
    defaults: params.defaults,
    field: "password",
    surface,
    topInactiveReason: "no enabled account inherits this top-level IRC password.",
  });
  collectNestedChannelFieldAssignments({
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.nickserv) && isEnabledFlag(account.nickserv),
    accountInactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
    channel: irc,
    channelKey: "irc",
    context: params.context,
    defaults: params.defaults,
    field: "password",
    nestedKey: "nickserv",
    surface,
    topInactiveReason:
      "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "nickserv") &&
      isRecord(irc.nickserv) &&
      isEnabledFlag(irc.nickserv),
  });
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
