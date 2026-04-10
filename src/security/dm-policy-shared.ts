import { evaluateMatchedGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "../channels/allow-from.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { GroupPolicy } from "../config/types.base.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

export function resolvePinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: (string | number)[] | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
  if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) {
    return null;
  }
  const normalizedOwners = [
    ...new Set(
      rawAllowFrom
        .map((entry) => params.normalizeEntry(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}

export function resolveEffectiveAllowFromLists(params: {
  allowFrom?: (string | number)[] | null;
  groupAllowFrom?: (string | number)[] | null;
  storeAllowFrom?: (string | number)[] | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : undefined;
  const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : undefined;
  const storeAllowFrom = Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : undefined;
  const effectiveAllowFrom = normalizeStringEntries(
    mergeDmAllowFromSources({
      allowFrom,
      dmPolicy: params.dmPolicy ?? undefined,
      storeAllowFrom,
    }),
  );
  // Group auth is explicit (groupAllowFrom fallback allowFrom). Pairing store is DM-only.
  const effectiveGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom,
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
      groupAllowFrom,
    }),
  );
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

export type DmGroupAccessDecision = "allow" | "block" | "pairing";
export const DM_GROUP_ACCESS_REASON = {
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
  GROUP_POLICY_ALLOWED: "group_policy_allowed",
  GROUP_POLICY_DISABLED: "group_policy_disabled",
  GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
  GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
} as const;
export type DmGroupAccessReasonCode =
  (typeof DM_GROUP_ACCESS_REASON)[keyof typeof DM_GROUP_ACCESS_REASON];

interface DmGroupAccessInputParams {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: (string | number)[] | null;
  groupAllowFrom?: (string | number)[] | null;
  storeAllowFrom?: (string | number)[] | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}

export async function readStoreAllowFromForDmPolicy(params: {
  provider: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (params.shouldRead === false || params.dmPolicy === "allowlist") {
    return [];
  }
  const readStore =
    params.readStore ??
    ((provider: ChannelId, accountId: string) =>
      readChannelAllowFromStore(provider, process.env, accountId));
  return await readStore(params.provider, params.accountId).catch(() => []);
}

export function resolveDmGroupAccessDecision(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  effectiveAllowFrom: (string | number)[];
  effectiveGroupAllowFrom: (string | number)[];
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
} {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy: GroupPolicy =
    params.groupPolicy === "open" || params.groupPolicy === "disabled"
      ? params.groupPolicy
      : "allowlist";
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);

  if (params.isGroup) {
    const groupAccess = evaluateMatchedGroupAccessForPolicy({
      allowlistConfigured: effectiveGroupAllowFrom.length > 0,
      allowlistMatched: params.isSenderAllowed(effectiveGroupAllowFrom),
      groupPolicy,
    });

    if (!groupAccess.allowed) {
      if (groupAccess.reason === "disabled") {
        return {
          decision: "block",
          reason: "groupPolicy=disabled",
          reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
        };
      }
      if (groupAccess.reason === "empty_allowlist") {
        return {
          decision: "block",
          reason: "groupPolicy=allowlist (empty allowlist)",
          reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
        };
      }
      if (groupAccess.reason === "not_allowlisted") {
        return {
          decision: "block",
          reason: "groupPolicy=allowlist (not allowlisted)",
          reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
        };
      }
    }

    return {
      decision: "allow",
      reason: `groupPolicy=${groupPolicy}`,
      reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
    };
  }

  if (dmPolicy === "disabled") {
    return {
      decision: "block",
      reason: "dmPolicy=disabled",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED,
    };
  }
  if (dmPolicy === "open") {
    return {
      decision: "allow",
      reason: "dmPolicy=open",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN,
    };
  }
  if (params.isSenderAllowed(effectiveAllowFrom)) {
    return {
      decision: "allow",
      reason: `dmPolicy=${dmPolicy} (allowlisted)`,
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
    };
  }
  if (dmPolicy === "pairing") {
    return {
      decision: "pairing",
      reason: "dmPolicy=pairing (not allowlisted)",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
    };
  }
  return {
    decision: "block",
    reason: `dmPolicy=${dmPolicy} (not allowlisted)`,
    reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
  };
}

export function resolveDmGroupAccessWithLists(params: DmGroupAccessInputParams): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.allowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFrom: params.groupAllowFrom,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
  });
  const access = resolveDmGroupAccessDecision({
    dmPolicy: params.dmPolicy,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    groupPolicy: params.groupPolicy,
    isGroup: params.isGroup,
    isSenderAllowed: params.isSenderAllowed,
  });
  return {
    ...access,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
  };
}

export function resolveDmGroupAccessWithCommandGate(
  params: DmGroupAccessInputParams & {
    command?: {
      useAccessGroups: boolean;
      allowTextCommands: boolean;
      hasControlCommand: boolean;
    };
  },
): {
  decision: DmGroupAccessDecision;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
} {
  const access = resolveDmGroupAccessWithLists({
    allowFrom: params.allowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFrom: params.groupAllowFrom,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
    groupPolicy: params.groupPolicy,
    isGroup: params.isGroup,
    isSenderAllowed: params.isSenderAllowed,
    storeAllowFrom: params.storeAllowFrom,
  });

  const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
  const configuredGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom: configuredAllowFrom,
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
      groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
    }),
  );
  // Group command authorization must not inherit DM pairing-store approvals.
  const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
  const commandGroupAllowFrom = params.isGroup
    ? configuredGroupAllowFrom
    : access.effectiveGroupAllowFrom;
  const ownerAllowedForCommands = params.isSenderAllowed(commandDmAllowFrom);
  const groupAllowedForCommands = params.isSenderAllowed(commandGroupAllowFrom);
  const commandGate = params.command
    ? resolveControlCommandGate({
        allowTextCommands: params.command.allowTextCommands,
        authorizers: [
          {
            allowed: ownerAllowedForCommands,
            configured: commandDmAllowFrom.length > 0,
          },
          {
            allowed: groupAllowedForCommands,
            configured: commandGroupAllowFrom.length > 0,
          },
        ],
        hasControlCommand: params.command.hasControlCommand,
        useAccessGroups: params.command.useAccessGroups,
      })
    : { commandAuthorized: false, shouldBlock: false };

  return {
    ...access,
    commandAuthorized: commandGate.commandAuthorized,
    shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock,
  };
}

export async function resolveDmAllowState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: (string | number)[] | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}> {
  const configAllowFrom = normalizeStringEntries(
    Array.isArray(params.allowFrom) ? params.allowFrom : undefined,
  );
  const hasWildcard = configAllowFrom.includes("*");
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    accountId: params.accountId,
    provider: params.provider,
    readStore: params.readStore,
  });
  const normalizeEntry = params.normalizeEntry ?? ((value: string) => value);
  const normalizedCfg = configAllowFrom
    .filter((value) => value !== "*")
    .map((value) => normalizeEntry(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedStore = storeAllowFrom
    .map((value) => normalizeEntry(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const allowCount = new Set([...normalizedCfg, ...normalizedStore]).size;
  return {
    allowCount,
    configAllowFrom,
    hasWildcard,
    isMultiUserDm: hasWildcard || allowCount > 1,
  };
}
