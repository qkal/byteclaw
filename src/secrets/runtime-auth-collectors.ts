import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles.js";
import { assertNoOAuthSecretRefPolicyViolations } from "../agents/auth-profiles/policy.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import {
  type ResolverContext,
  type SecretDefaults,
  pushAssignment,
  pushWarning,
} from "./runtime-shared.js";
import { isNonEmptyString } from "./shared.js";

type ApiKeyCredentialLike = AuthProfileCredential & {
  type: "api_key";
  key?: string;
  keyRef?: unknown;
};

type TokenCredentialLike = AuthProfileCredential & {
  type: "token";
  token?: string;
  tokenRef?: unknown;
};

function collectApiKeyProfileAssignment(params: {
  profile: ApiKeyCredentialLike;
  profileId: string;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const {
    explicitRef: keyRef,
    inlineRef: inlineKeyRef,
    ref: resolvedKeyRef,
  } = resolveSecretInputRef({
    defaults: params.defaults,
    refValue: params.profile.keyRef,
    value: params.profile.key,
  });
  if (!resolvedKeyRef) {
    return;
  }
  if (!keyRef && inlineKeyRef) {
    params.profile.keyRef = inlineKeyRef;
  }
  if (keyRef && isNonEmptyString(params.profile.key)) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      message: `auth-profiles ${params.profileId}: keyRef is set; runtime will ignore plaintext key.`,
      path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
    });
  }
  pushAssignment(params.context, {
    apply: (value) => {
      params.profile.key = String(value);
    },
    expected: "string",
    path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
    ref: resolvedKeyRef,
  });
}

function collectTokenProfileAssignment(params: {
  profile: TokenCredentialLike;
  profileId: string;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const {
    explicitRef: tokenRef,
    inlineRef: inlineTokenRef,
    ref: resolvedTokenRef,
  } = resolveSecretInputRef({
    defaults: params.defaults,
    refValue: params.profile.tokenRef,
    value: params.profile.token,
  });
  if (!resolvedTokenRef) {
    return;
  }
  if (!tokenRef && inlineTokenRef) {
    params.profile.tokenRef = inlineTokenRef;
  }
  if (tokenRef && isNonEmptyString(params.profile.token)) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      message: `auth-profiles ${params.profileId}: tokenRef is set; runtime will ignore plaintext token.`,
      path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
    });
  }
  pushAssignment(params.context, {
    apply: (value) => {
      params.profile.token = String(value);
    },
    expected: "string",
    path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
    ref: resolvedTokenRef,
  });
}

export function collectAuthStoreAssignments(params: {
  store: AuthProfileStore;
  context: ResolverContext;
  agentDir: string;
}): void {
  assertNoOAuthSecretRefPolicyViolations({
    cfg: params.context.sourceConfig,
    context: `auth-profiles ${params.agentDir}`,
    store: params.store,
  });

  const defaults = params.context.sourceConfig.secrets?.defaults;
  for (const [profileId, profile] of Object.entries(params.store.profiles)) {
    if (profile.type === "api_key") {
      collectApiKeyProfileAssignment({
        agentDir: params.agentDir,
        context: params.context,
        defaults,
        profile: profile as ApiKeyCredentialLike,
        profileId,
      });
      continue;
    }
    if (profile.type === "token") {
      collectTokenProfileAssignment({
        agentDir: params.agentDir,
        context: params.context,
        defaults,
        profile: profile as TokenCredentialLike,
        profileId,
      });
    }
  }
}
