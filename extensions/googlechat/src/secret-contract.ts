import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  getChannelSurface,
  hasOwnProperty,
  pushAssignment,
  pushInactiveSurfaceWarning,
  pushWarning,
  resolveChannelAccountSurface,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

interface GoogleChatAccountLike {
  serviceAccount?: unknown;
  serviceAccountRef?: unknown;
  accounts?: Record<string, unknown>;
}

export const secretTargetRegistryEntries = [
  {
    accountIdPathSegmentIndex: 3,
    configFile: "openclaw.json",
    expectedResolvedValue: "string-or-object",
    id: "channels.googlechat.accounts.*.serviceAccount",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.googlechat.accounts.*.serviceAccount",
    refPathPattern: "channels.googlechat.accounts.*.serviceAccountRef",
    secretShape: "sibling_ref",
    targetType: "channels.googlechat.serviceAccount",
    targetTypeAliases: ["channels.googlechat.accounts.*.serviceAccount"],
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string-or-object",
    id: "channels.googlechat.serviceAccount",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.googlechat.serviceAccount",
    refPathPattern: "channels.googlechat.serviceAccountRef",
    secretShape: "sibling_ref",
    targetType: "channels.googlechat.serviceAccount",
  },
] satisfies SecretTargetRegistryEntry[];

function resolveSecretInputRef(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
}) {
  const explicitRef = coerceSecretRef(params.refValue, params.defaults);
  const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
  return {
    explicitRef,
    inlineRef,
    ref: explicitRef ?? inlineRef,
  };
}

function collectGoogleChatAccountAssignment(params: {
  target: GoogleChatAccountLike;
  path: string;
  defaults?: SecretDefaults;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const { explicitRef, ref } = resolveSecretInputRef({
    defaults: params.defaults,
    refValue: params.target.serviceAccountRef,
    value: params.target.serviceAccount,
  });
  if (!ref) {
    return;
  }
  if (params.active === false) {
    pushInactiveSurfaceWarning({
      context: params.context,
      details: params.inactiveReason,
      path: `${params.path}.serviceAccount`,
    });
    return;
  }
  if (
    explicitRef &&
    params.target.serviceAccount !== undefined &&
    !coerceSecretRef(params.target.serviceAccount, params.defaults)
  ) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      message: `${params.path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`,
      path: params.path,
    });
  }
  pushAssignment(params.context, {
    apply: (value) => {
      params.target.serviceAccount = value;
    },
    expected: "string-or-object",
    path: `${params.path}.serviceAccount`,
    ref,
  });
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "googlechat");
  if (!resolved) {
    return;
  }
  const googleChat = resolved.channel as GoogleChatAccountLike;
  const surface = resolveChannelAccountSurface(googleChat as Record<string, unknown>);
  const topLevelServiceAccountActive = !surface.channelEnabled
    ? false
    : (!surface.hasExplicitAccounts
      ? true
      : surface.accounts.some(
          ({ account, enabled }) =>
            enabled &&
            !hasOwnProperty(account, "serviceAccount") &&
            !hasOwnProperty(account, "serviceAccountRef"),
        ));
  collectGoogleChatAccountAssignment({
    active: topLevelServiceAccountActive,
    context: params.context,
    defaults: params.defaults,
    inactiveReason: "no enabled account inherits this top-level Google Chat serviceAccount.",
    path: "channels.googlechat",
    target: googleChat,
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (
      !hasOwnProperty(account, "serviceAccount") &&
      !hasOwnProperty(account, "serviceAccountRef")
    ) {
      continue;
    }
    collectGoogleChatAccountAssignment({
      active: enabled,
      context: params.context,
      defaults: params.defaults,
      inactiveReason: "Google Chat account is disabled.",
      path: `channels.googlechat.accounts.${accountId}`,
      target: account as GoogleChatAccountLike,
    });
  }
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
