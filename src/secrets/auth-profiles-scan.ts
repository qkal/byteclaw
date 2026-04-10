import { isNonEmptyString, isRecord } from "./shared.js";
import { listAuthProfileSecretTargetEntries } from "./target-registry.js";

export type AuthProfileCredentialType = "api_key" | "token";

interface AuthProfileFieldSpec {
  valueField: string;
  refField: string;
}

interface ApiKeyCredentialVisit {
  kind: "api_key";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  valueField: string;
  refField: string;
  value: unknown;
  refValue: unknown;
}

interface TokenCredentialVisit {
  kind: "token";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  valueField: string;
  refField: string;
  value: unknown;
  refValue: unknown;
}

interface OauthCredentialVisit {
  kind: "oauth";
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
  hasAccess: boolean;
  hasRefresh: boolean;
}

export type AuthProfileCredentialVisit =
  | ApiKeyCredentialVisit
  | TokenCredentialVisit
  | OauthCredentialVisit;

function getAuthProfileFieldName(pathPattern: string): string {
  const segments = pathPattern.split(".").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

const AUTH_PROFILE_FIELD_SPEC_BY_TYPE = (() => {
  const defaults: Record<AuthProfileCredentialType, AuthProfileFieldSpec> = {
    api_key: { refField: "keyRef", valueField: "key" },
    token: { refField: "tokenRef", valueField: "token" },
  };
  for (const target of listAuthProfileSecretTargetEntries()) {
    if (!target.authProfileType) {
      continue;
    }
    defaults[target.authProfileType] = {
      refField:
        target.refPathPattern !== undefined
          ? getAuthProfileFieldName(target.refPathPattern)
          : defaults[target.authProfileType].refField,
      valueField: getAuthProfileFieldName(target.pathPattern),
    };
  }
  return defaults;
})();

export function getAuthProfileFieldSpec(type: AuthProfileCredentialType): AuthProfileFieldSpec {
  return AUTH_PROFILE_FIELD_SPEC_BY_TYPE[type];
}

function toSecretCredentialVisit(params: {
  kind: AuthProfileCredentialType;
  profileId: string;
  provider: string;
  profile: Record<string, unknown>;
}): ApiKeyCredentialVisit | TokenCredentialVisit {
  const spec = getAuthProfileFieldSpec(params.kind);
  return {
    kind: params.kind,
    profile: params.profile,
    profileId: params.profileId,
    provider: params.provider,
    refField: spec.refField,
    refValue: params.profile[spec.refField],
    value: params.profile[spec.valueField],
    valueField: spec.valueField,
  };
}

export function* iterateAuthProfileCredentials(
  profiles: Record<string, unknown>,
): Iterable<AuthProfileCredentialVisit> {
  for (const [profileId, value] of Object.entries(profiles)) {
    if (!isRecord(value) || !isNonEmptyString(value.provider)) {
      continue;
    }
    const provider = String(value.provider);
    if (value.type === "api_key" || value.type === "token") {
      yield toSecretCredentialVisit({
        kind: value.type,
        profile: value,
        profileId,
        provider,
      });
      continue;
    }
    if (value.type === "oauth") {
      yield {
        hasAccess: isNonEmptyString(value.access),
        hasRefresh: isNonEmptyString(value.refresh),
        kind: "oauth",
        profile: value,
        profileId,
        provider,
      };
    }
  }
}
