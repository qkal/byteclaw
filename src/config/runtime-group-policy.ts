import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { GroupPolicy } from "./types.base.js";

export interface RuntimeGroupPolicyResolution {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
}

export interface RuntimeGroupPolicyParams {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  configuredFallbackPolicy?: GroupPolicy;
  missingProviderFallbackPolicy?: GroupPolicy;
}

export function resolveRuntimeGroupPolicy(
  params: RuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  const configuredFallbackPolicy = params.configuredFallbackPolicy ?? "open";
  const missingProviderFallbackPolicy = params.missingProviderFallbackPolicy ?? "allowlist";
  const groupPolicy = params.providerConfigPresent
    ? (params.groupPolicy ?? params.defaultGroupPolicy ?? configuredFallbackPolicy)
    : (params.groupPolicy ?? missingProviderFallbackPolicy);
  const providerMissingFallbackApplied =
    !params.providerConfigPresent && params.groupPolicy === undefined;
  return { groupPolicy, providerMissingFallbackApplied };
}

export interface ResolveProviderRuntimeGroupPolicyParams {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}

export interface GroupPolicyDefaultsConfig {
  channels?: {
    defaults?: {
      groupPolicy?: GroupPolicy;
    };
  };
}

export function resolveDefaultGroupPolicy(cfg: GroupPolicyDefaultsConfig): GroupPolicy | undefined {
  return cfg.channels?.defaults?.groupPolicy;
}

export const GROUP_POLICY_BLOCKED_LABEL = {
  channel: "channel messages",
  group: "group messages",
  guild: "guild messages",
  room: "room messages",
  space: "space messages",
} as const;

/**
 * Standard provider runtime policy:
 * - configured provider fallback: open
 * - missing provider fallback: allowlist (fail-closed)
 */
export function resolveOpenProviderRuntimeGroupPolicy(
  params: ResolveProviderRuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  return resolveRuntimeGroupPolicy({
    configuredFallbackPolicy: "open",
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupPolicy: params.groupPolicy,
    missingProviderFallbackPolicy: "allowlist",
    providerConfigPresent: params.providerConfigPresent,
  });
}

/**
 * Strict provider runtime policy:
 * - configured provider fallback: allowlist
 * - missing provider fallback: allowlist (fail-closed)
 */
export function resolveAllowlistProviderRuntimeGroupPolicy(
  params: ResolveProviderRuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  return resolveRuntimeGroupPolicy({
    configuredFallbackPolicy: "allowlist",
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupPolicy: params.groupPolicy,
    missingProviderFallbackPolicy: "allowlist",
    providerConfigPresent: params.providerConfigPresent,
  });
}

const warnedMissingProviderGroupPolicy = new Set<string>();

export function warnMissingProviderGroupPolicyFallbackOnce(params: {
  providerMissingFallbackApplied: boolean;
  providerKey: string;
  accountId?: string;
  blockedLabel?: string;
  log: (message: string) => void;
}): boolean {
  if (!params.providerMissingFallbackApplied) {
    return false;
  }
  const key = `${params.providerKey}:${params.accountId ?? "*"}`;
  if (warnedMissingProviderGroupPolicy.has(key)) {
    return false;
  }
  warnedMissingProviderGroupPolicy.add(key);
  const blockedLabel = normalizeOptionalString(params.blockedLabel) || "group messages";
  params.log(
    `${params.providerKey}: channels.${params.providerKey} is missing; defaulting groupPolicy to "allowlist" (${blockedLabel} blocked until explicitly configured).`,
  );
  return true;
}

/**
 * Test helper. Keeps warning-cache state deterministic across test files.
 */
export function resetMissingProviderGroupPolicyFallbackWarningsForTesting(): void {
  warnedMissingProviderGroupPolicy.clear();
}
