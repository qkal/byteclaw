import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
  collectSecretInputAssignment,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  hasOwnProperty,
  normalizeSecretStringValue,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { getMatrixScopedEnvVarNames } from "./env-vars.js";

export const secretTargetRegistryEntries = [
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.matrix.accounts.*.accessToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.matrix.accounts.*.accessToken",
    secretShape: "secret_input",
    targetType: "channels.matrix.accounts.*.accessToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.matrix.accounts.*.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.matrix.accounts.*.password",
    secretShape: "secret_input",
    targetType: "channels.matrix.accounts.*.password",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.matrix.accessToken",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.matrix.accessToken",
    secretShape: "secret_input",
    targetType: "channels.matrix.accessToken",
  },
  {
    configFile: "openclaw.json",
    expectedResolvedValue: "string",
    id: "channels.matrix.password",
    includeInAudit: true,
    includeInConfigure: true,
    includeInPlan: true,
    pathPattern: "channels.matrix.password",
    secretShape: "secret_input",
    targetType: "channels.matrix.password",
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "matrix");
  if (!resolved) {
    return;
  }
  const { channel: matrix, surface } = resolved;
  const envAccessTokenConfigured =
    normalizeSecretStringValue(params.context.env.MATRIX_ACCESS_TOKEN).length > 0;
  const defaultScopedAccessTokenConfigured =
    normalizeSecretStringValue(
      params.context.env[getMatrixScopedEnvVarNames("default").accessToken],
    ).length > 0;
  const defaultAccountAccessTokenConfigured = surface.accounts.some(
    ({ accountId, account }) =>
      normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID &&
      hasConfiguredSecretInputValue(account.accessToken, params.defaults),
  );
  const baseAccessTokenConfigured = hasConfiguredSecretInputValue(
    matrix.accessToken,
    params.defaults,
  );
  collectSecretInputAssignment({
    active: surface.channelEnabled,
    apply: (value) => {
      matrix.accessToken = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    inactiveReason: "Matrix channel is disabled.",
    path: "channels.matrix.accessToken",
    value: matrix.accessToken,
  });
  collectSecretInputAssignment({
    active:
      surface.channelEnabled &&
      !(
        baseAccessTokenConfigured ||
        envAccessTokenConfigured ||
        defaultScopedAccessTokenConfigured ||
        defaultAccountAccessTokenConfigured
      ),
    apply: (value) => {
      matrix.password = value;
    },
    context: params.context,
    defaults: params.defaults,
    expected: "string",
    inactiveReason:
      "Matrix channel is disabled or access-token auth is configured for the default Matrix account.",
    path: "channels.matrix.password",
    value: matrix.password,
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (hasOwnProperty(account, "accessToken")) {
      collectSecretInputAssignment({
        active: enabled,
        apply: (value) => {
          account.accessToken = value;
        },
        context: params.context,
        defaults: params.defaults,
        expected: "string",
        inactiveReason: "Matrix account is disabled.",
        path: `channels.matrix.accounts.${accountId}.accessToken`,
        value: account.accessToken,
      });
    }
    if (!hasOwnProperty(account, "password")) {
      continue;
    }
    const accountAccessTokenConfigured = hasConfiguredSecretInputValue(
      account.accessToken,
      params.defaults,
    );
    const scopedEnvAccessTokenConfigured =
      normalizeSecretStringValue(
        params.context.env[getMatrixScopedEnvVarNames(accountId).accessToken],
      ).length > 0;
    const inheritedDefaultAccountAccessTokenConfigured =
      normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID &&
      (baseAccessTokenConfigured || envAccessTokenConfigured);
    collectSecretInputAssignment({
      active:
        enabled &&
        !(
          accountAccessTokenConfigured ||
          scopedEnvAccessTokenConfigured ||
          inheritedDefaultAccountAccessTokenConfigured
        ),
      apply: (value) => {
        account.password = value;
      },
      context: params.context,
      defaults: params.defaults,
      expected: "string",
      inactiveReason: "Matrix account is disabled or this account has an accessToken configured.",
      path: `channels.matrix.accounts.${accountId}.password`,
      value: account.password,
    });
  }
}

export const channelSecrets = {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
};
