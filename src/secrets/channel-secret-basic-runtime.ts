import { coerceSecretRef } from "../config/types.secrets.js";
import {
  type ResolverContext,
  type SecretDefaults,
  collectSecretInputAssignment,
  hasOwnProperty,
  isChannelAccountEffectivelyEnabled,
  isEnabledFlag,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

export interface ChannelAccountEntry {
  accountId: string;
  account: Record<string, unknown>;
  enabled: boolean;
}

export interface ChannelAccountSurface {
  hasExplicitAccounts: boolean;
  channelEnabled: boolean;
  accounts: ChannelAccountEntry[];
}

export type ChannelAccountPredicate = (entry: ChannelAccountEntry) => boolean;

export function getChannelRecord(
  config: { channels?: Record<string, unknown> },
  channelKey: string,
): Record<string, unknown> | undefined {
  const { channels } = config;
  if (!isRecord(channels)) {
    return undefined;
  }
  const channel = channels[channelKey];
  return isRecord(channel) ? channel : undefined;
}

export function getChannelSurface(
  config: { channels?: Record<string, unknown> },
  channelKey: string,
): { channel: Record<string, unknown>; surface: ChannelAccountSurface } | null {
  const channel = getChannelRecord(config, channelKey);
  if (!channel) {
    return null;
  }
  return {
    channel,
    surface: resolveChannelAccountSurface(channel),
  };
}

export function resolveChannelAccountSurface(
  channel: Record<string, unknown>,
): ChannelAccountSurface {
  const channelEnabled = isEnabledFlag(channel);
  const { accounts } = channel;
  if (!isRecord(accounts) || Object.keys(accounts).length === 0) {
    return {
      accounts: [{ account: channel, accountId: "default", enabled: channelEnabled }],
      channelEnabled,
      hasExplicitAccounts: false,
    };
  }
  const accountEntries: ChannelAccountEntry[] = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account)) {
      continue;
    }
    accountEntries.push({
      account,
      accountId,
      enabled: isChannelAccountEffectivelyEnabled(channel, account),
    });
  }
  return {
    accounts: accountEntries,
    channelEnabled,
    hasExplicitAccounts: true,
  };
}

export function isBaseFieldActiveForChannelSurface(
  surface: ChannelAccountSurface,
  rootKey: string,
): boolean {
  if (!surface.channelEnabled) {
    return false;
  }
  if (!surface.hasExplicitAccounts) {
    return true;
  }
  return surface.accounts.some(
    ({ account, enabled }) => enabled && !hasOwnProperty(account, rootKey),
  );
}

export function normalizeSecretStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hasConfiguredSecretInputValue(
  value: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  return normalizeSecretStringValue(value).length > 0 || coerceSecretRef(value, defaults) !== null;
}

export function collectSimpleChannelFieldAssignments(params: {
  channelKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topInactiveReason: string;
  accountInactiveReason: string;
}): void {
  collectSecretInputAssignment({
    active: isBaseFieldActiveForChannelSurface(params.surface, params.field),
    apply: (value) => {
      params.channel[params.field] = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    inactiveReason: params.topInactiveReason,
    path: `channels.${params.channelKey}.${params.field}`,
    value: params.channel[params.field],
  });
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of params.surface.accounts) {
    if (!hasOwnProperty(account, params.field)) {
      continue;
    }
    collectSecretInputAssignment({
      active: enabled,
      apply: (value) => {
        account[params.field] = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: params.accountInactiveReason,
      path: `channels.${params.channelKey}.accounts.${accountId}.${params.field}`,
      value: account[params.field],
    });
  }
}

function isConditionalTopLevelFieldActive(params: {
  surface: ChannelAccountSurface;
  activeWithoutAccounts: boolean;
  inheritedAccountActive: ChannelAccountPredicate;
}): boolean {
  if (!params.surface.channelEnabled) {
    return false;
  }
  if (!params.surface.hasExplicitAccounts) {
    return params.activeWithoutAccounts;
  }
  return params.surface.accounts.some(params.inheritedAccountActive);
}

export function collectConditionalChannelFieldAssignments(params: {
  channelKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topLevelActiveWithoutAccounts: boolean;
  topLevelInheritedAccountActive: ChannelAccountPredicate;
  accountActive: ChannelAccountPredicate;
  topInactiveReason: string;
  accountInactiveReason: string | ((entry: ChannelAccountEntry) => string);
}): void {
  collectSecretInputAssignment({
    active: isConditionalTopLevelFieldActive({
      activeWithoutAccounts: params.topLevelActiveWithoutAccounts,
      inheritedAccountActive: params.topLevelInheritedAccountActive,
      surface: params.surface,
    }),
    apply: (value) => {
      params.channel[params.field] = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    inactiveReason: params.topInactiveReason,
    path: `channels.${params.channelKey}.${params.field}`,
    value: params.channel[params.field],
  });
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const entry of params.surface.accounts) {
    if (!hasOwnProperty(entry.account, params.field)) {
      continue;
    }
    collectSecretInputAssignment({
      active: params.accountActive(entry),
      apply: (value) => {
        entry.account[params.field] = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason:
        typeof params.accountInactiveReason === "function"
          ? params.accountInactiveReason(entry)
          : params.accountInactiveReason,
      path: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.field}`,
      value: entry.account[params.field],
    });
  }
}

export function collectNestedChannelFieldAssignments(params: {
  channelKey: string;
  nestedKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topLevelActive: boolean;
  topInactiveReason: string;
  accountActive: ChannelAccountPredicate;
  accountInactiveReason: string | ((entry: ChannelAccountEntry) => string);
}): void {
  const topLevelNested = params.channel[params.nestedKey];
  if (isRecord(topLevelNested)) {
    collectSecretInputAssignment({
      active: params.topLevelActive,
      apply: (value) => {
        topLevelNested[params.field] = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: params.topInactiveReason,
      path: `channels.${params.channelKey}.${params.nestedKey}.${params.field}`,
      value: topLevelNested[params.field],
    });
  }
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const entry of params.surface.accounts) {
    const nested = entry.account[params.nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    collectSecretInputAssignment({
      active: params.accountActive(entry),
      apply: (value) => {
        nested[params.field] = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason:
        typeof params.accountInactiveReason === "function"
          ? params.accountInactiveReason(entry)
          : params.accountInactiveReason,
      path: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.nestedKey}.${params.field}`,
      value: nested[params.field],
    });
  }
}
