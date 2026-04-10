import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/allow-from";
import {
  type GroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";
import {
  type SenderGroupAccessDecision,
  evaluateSenderGroupAccess,
} from "openclaw/plugin-sdk/group-access";

const ZALO_ALLOW_FROM_PREFIX_RE = /^(zalo|zl):/i;

export function isZaloSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  return isNormalizedSenderAllowed({
    allowFrom,
    senderId,
    stripPrefixRe: ZALO_ALLOW_FROM_PREFIX_RE,
  });
}

export function resolveZaloRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
}): {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
} {
  return resolveOpenProviderRuntimeGroupPolicy({
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupPolicy: params.groupPolicy,
    providerConfigPresent: params.providerConfigPresent,
  });
}

export function evaluateZaloGroupAccess(params: {
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy;
  defaultGroupPolicy?: GroupPolicy;
  groupAllowFrom: string[];
  senderId: string;
}): SenderGroupAccessDecision {
  return evaluateSenderGroupAccess({
    configuredGroupPolicy: params.configuredGroupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupAllowFrom: params.groupAllowFrom,
    isSenderAllowed: isZaloSenderAllowed,
    providerConfigPresent: params.providerConfigPresent,
    senderId: params.senderId,
  });
}
