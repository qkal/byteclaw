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
import { collectNestedChannelTtsAssignments } from "openclaw/plugin-sdk/channel-secret-tts-runtime";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.discord.accounts.*.pluralkit.token",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.discord.accounts.*.pluralkit.token",
    secretShape: "secret_input",
    targetType: "channels.discord.accounts.*.pluralkit.token",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.discord.accounts.*.token",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.discord.accounts.*.token",
    secretShape: "secret_input",
    targetType: "channels.discord.accounts.*.token",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
    providerIdPathSegmentIndex: 6,
    secretShape: "secret_input",
    targetType: "channels.discord.accounts.*.voice.tts.providers.*.apiKey",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.discord.pluralkit.token",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.discord.pluralkit.token",
    secretShape: "secret_input",
    targetType: "channels.discord.pluralkit.token",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.discord.token",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.discord.token",
    secretShape: "secret_input",
    targetType: "channels.discord.token",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.discord.voice.tts.providers.*.apiKey",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.discord.voice.tts.providers.*.apiKey",
    providerIdPathSegmentIndex: 4,
    secretShape: "secret_input",
    targetType: "channels.discord.voice.tts.providers.*.apiKey",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "discord");
  if (!resolved) {
    return;
  }
  const { channel: discord, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    accountInactiveReason: "Discord account is disabled.",
    channel: discord,
    channelKey: "discord",
    context: params.context,
    defaults: params.defaults,
    field: "token",
    surface,
    topInactiveReason: "no enabled account inherits this top-level Discord token.",
  });
  collectNestedChannelFieldAssignments({
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.pluralkit) && isEnabledFlag(account.pluralkit),
    accountInactiveReason: "Discord account is disabled or PluralKit is disabled for this account.",
    channel: discord,
    channelKey: "discord",
    context: params.context,
    defaults: params.defaults,
    field: "token",
    nestedKey: "pluralkit",
    surface,
    topInactiveReason:
      "no enabled Discord surface inherits this top-level PluralKit config or PluralKit is disabled.",
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "pluralkit") &&
      isRecord(discord.pluralkit) &&
      isEnabledFlag(discord.pluralkit),
  });
  collectNestedChannelTtsAssignments({
    accountActive: ({ account, enabled }) =>
      enabled && isRecord(account.voice) && isEnabledFlag(account.voice),
    accountInactiveReason: "Discord account is disabled or voice is disabled for this account.",
    channel: discord,
    channelKey: "discord",
    context: params.context,
    defaults: params.defaults,
    nestedKey: "voice",
    surface,
    topInactiveReason:
      "no enabled Discord surface inherits this top-level voice config or voice is disabled.",
    topLevelActive:
      isBaseFieldActiveForChannelSurface(surface, "voice") &&
      isRecord(discord.voice) &&
      isEnabledFlag(discord.voice),
  });
}
