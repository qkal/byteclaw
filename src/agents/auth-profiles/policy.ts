import type { OpenClawConfig } from "../../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../../config/types.secrets.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

interface OAuthSecretRefPolicyViolation {
  profileId: string;
  path: string;
  reason: string;
}

function pushViolation(
  violations: OAuthSecretRefPolicyViolation[],
  profileId: string,
  field: string,
  reason: string,
): void {
  violations.push({
    path: `profiles.${profileId}.${field}`,
    profileId,
    reason,
  });
}

function hasSecretRefInput(params: {
  value: unknown;
  refValue?: unknown;
  defaults: SecretDefaults | undefined;
}): boolean {
  return (
    resolveSecretInputRef({
      defaults: params.defaults,
      refValue: params.refValue,
      value: params.value,
    }).ref !== null
  );
}

function collectTypeOAuthSecretRefViolations(params: {
  profileId: string;
  credential: AuthProfileCredential;
  defaults: SecretDefaults | undefined;
  violations: OAuthSecretRefPolicyViolation[];
}): void {
  if (params.credential.type !== "oauth") {
    return;
  }
  const reason =
    'SecretRef is not allowed for type="oauth" auth profiles (OAuth credentials are runtime-mutable).';
  const record = params.credential as Record<string, unknown>;
  for (const field of ["access", "refresh", "token", "tokenRef", "key", "keyRef"] as const) {
    if (coerceSecretRef(record[field], params.defaults) === null) {
      continue;
    }
    pushViolation(params.violations, params.profileId, field, reason);
  }
}

function collectOAuthModeSecretRefViolations(params: {
  profileId: string;
  credential: AuthProfileCredential;
  defaults: SecretDefaults | undefined;
  configuredMode?: "api_key" | "oauth" | "token";
  violations: OAuthSecretRefPolicyViolation[];
}): void {
  if (params.configuredMode !== "oauth") {
    return;
  }
  const reason =
    `SecretRef is not allowed when auth.profiles.${params.profileId}.mode is "oauth" ` +
    "(OAuth credentials are runtime-mutable).";
  if (params.credential.type === "api_key") {
    if (
      hasSecretRefInput({
        defaults: params.defaults,
        refValue: params.credential.keyRef,
        value: params.credential.key,
      })
    ) {
      pushViolation(params.violations, params.profileId, "key", reason);
    }
    return;
  }
  if (params.credential.type === "token") {
    if (
      hasSecretRefInput({
        defaults: params.defaults,
        refValue: params.credential.tokenRef,
        value: params.credential.token,
      })
    ) {
      pushViolation(params.violations, params.profileId, "token", reason);
    }
  }
}

export function collectOAuthSecretRefPolicyViolations(params: {
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  profileIds?: Iterable<string>;
}): OAuthSecretRefPolicyViolation[] {
  const defaults = params.cfg?.secrets?.defaults;
  const profileFilter = params.profileIds ? new Set(params.profileIds) : null;
  const violations: OAuthSecretRefPolicyViolation[] = [];
  for (const [profileId, credential] of Object.entries(params.store.profiles)) {
    if (profileFilter && !profileFilter.has(profileId)) {
      continue;
    }
    collectTypeOAuthSecretRefViolations({
      credential,
      defaults,
      profileId,
      violations,
    });
    collectOAuthModeSecretRefViolations({
      configuredMode: params.cfg?.auth?.profiles?.[profileId]?.mode,
      credential,
      defaults,
      profileId,
      violations,
    });
  }
  return violations;
}

export function assertNoOAuthSecretRefPolicyViolations(params: {
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  profileIds?: Iterable<string>;
  context?: string;
}): void {
  const violations = collectOAuthSecretRefPolicyViolations(params);
  if (violations.length === 0) {
    return;
  }
  const lines = [
    `${params.context ?? "auth-profiles"} policy validation failed: OAuth + SecretRef is not supported.`,
    ...violations.map((violation) => `- ${violation.path}: ${violation.reason}`),
  ];
  throw new Error(lines.join("\n"));
}
