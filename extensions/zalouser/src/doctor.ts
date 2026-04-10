import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isZalouserMutableGroupEntry } from "./security-audit.js";

type ZalouserChannelsConfig = NonNullable<OpenClawConfig["channels"]>;

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacyZalouserGroupAllowAlias(value: unknown): boolean {
  const group = asObjectRecord(value);
  return Boolean(group && typeof group.allow === "boolean");
}

function hasLegacyZalouserGroupAllowAliases(value: unknown): boolean {
  const groups = asObjectRecord(value);
  return Boolean(
    groups && Object.values(groups).some((group) => hasLegacyZalouserGroupAllowAlias(group)),
  );
}

function hasLegacyZalouserAccountGroupAllowAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => {
    const accountRecord = asObjectRecord(account);
    return Boolean(accountRecord && hasLegacyZalouserGroupAllowAliases(accountRecord.groups));
  });
}

function normalizeZalouserGroupAllowAliases(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups: Record<string, unknown> = { ...params.groups };
  for (const [groupId, groupValue] of Object.entries(params.groups)) {
    const group = asObjectRecord(groupValue);
    if (!group || typeof group.allow !== "boolean") {
      continue;
    }
    const nextGroup = { ...group };
    if (typeof nextGroup.enabled !== "boolean") {
      nextGroup.enabled = group.allow;
    }
    delete nextGroup.allow;
    nextGroups[groupId] = nextGroup;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled (${String(nextGroup.enabled)}).`,
    );
  }
  return { changed, groups: nextGroups };
}

function normalizeZalouserCompatibilityConfig(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  const channels = asObjectRecord(cfg.channels);
  const zalouser = asObjectRecord(channels?.zalouser);
  if (!zalouser) {
    return { changes: [], config: cfg };
  }

  const changes: string[] = [];
  let updatedZalouser: Record<string, unknown> = zalouser;
  let changed = false;

  const groups = asObjectRecord(updatedZalouser.groups);
  if (groups) {
    const normalized = normalizeZalouserGroupAllowAliases({
      changes,
      groups,
      pathPrefix: "channels.zalouser.groups",
    });
    if (normalized.changed) {
      updatedZalouser = { ...updatedZalouser, groups: normalized.groups };
      changed = true;
    }
  }

  const accounts = asObjectRecord(updatedZalouser.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts: Record<string, unknown> = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = asObjectRecord(accountValue);
      if (!account) {
        continue;
      }
      const accountGroups = asObjectRecord(account.groups);
      if (!accountGroups) {
        continue;
      }
      const normalized = normalizeZalouserGroupAllowAliases({
        changes,
        groups: accountGroups,
        pathPrefix: `channels.zalouser.accounts.${accountId}.groups`,
      });
      if (!normalized.changed) {
        continue;
      }
      nextAccounts[accountId] = {
        ...account,
        groups: normalized.groups,
      };
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedZalouser = { ...updatedZalouser, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { changes: [], config: cfg };
  }

  return {
    changes,
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalouser: updatedZalouser as ZalouserChannelsConfig["zalouser"],
      },
    },
  };
}

const ZALOUSER_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    match: hasLegacyZalouserGroupAllowAliases,
    message:
      'channels.zalouser.groups.<id>.allow is legacy; use channels.zalouser.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    path: ["channels", "zalouser", "groups"],
  },
  {
    match: hasLegacyZalouserAccountGroupAllowAliases,
    message:
      'channels.zalouser.accounts.<id>.groups.<id>.allow is legacy; use channels.zalouser.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    path: ["channels", "zalouser", "accounts"],
  },
];

export const legacyConfigRules = ZALOUSER_LEGACY_CONFIG_RULES;

export function normalizeCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return normalizeZalouserCompatibilityConfig(params.cfg);
}

export const collectZalouserMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "zalouser",
    collectLists: (scope) => {
      const groups = asObjectRecord(scope.account.groups);
      return groups
        ? [
            {
              list: Object.keys(groups),
              pathLabel: `${scope.prefix}.groups`,
            },
          ]
        : [];
    },
    detector: isZalouserMutableGroupEntry,
  });

export const zalouserDoctor: ChannelDoctorAdapter = {
  collectMutableAllowlistWarnings: collectZalouserMutableAllowlistWarnings,
  dmAllowFromMode: "topOnly",
  groupAllowFromFallbackToAllowFrom: false,
  groupModel: "hybrid",
  legacyConfigRules,
  normalizeCompatibilityConfig,
  warnOnEmptyGroupSenderAllowlist: false,
};
