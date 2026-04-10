import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalAuthProfileMap = Map<string, ProviderExternalAuthProfile>;

function normalizeExternalAuthProfile(
  profile: ProviderExternalAuthProfile,
): ProviderExternalAuthProfile | null {
  if (!profile?.profileId || !profile.credential) {
    return null;
  }
  return {
    ...profile,
    persistence: profile.persistence ?? "runtime-only",
  };
}

function resolveExternalAuthProfileMap(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): ExternalAuthProfileMap {
  const env = params.env ?? process.env;
  const profiles = resolveExternalAuthProfilesWithPlugins({
    context: {
      agentDir: params.agentDir,
      config: undefined,
      env,
      store: params.store,
      workspaceDir: undefined,
    },
    env,
  });

  const resolved: ExternalAuthProfileMap = new Map();
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

function oauthCredentialMatches(a: OAuthCredential, b: OAuthCredential): boolean {
  return (
    a.type === b.type &&
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.clientId === b.clientId &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

export function overlayExternalAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv },
): AuthProfileStore {
  const profiles = resolveExternalAuthProfileMap({
    agentDir: params?.agentDir,
    env: params?.env,
    store,
  });
  if (profiles.size === 0) {
    return store;
  }

  const next = structuredClone(store);
  for (const [profileId, profile] of profiles) {
    next.profiles[profileId] = profile.credential;
  }
  return next;
}

export function shouldPersistExternalAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const external = resolveExternalAuthProfileMap({
    agentDir: params.agentDir,
    env: params.env,
    store: params.store,
  }).get(params.profileId);
  if (!external || external.persistence === "persisted") {
    return true;
  }
  return !oauthCredentialMatches(external.credential, params.credential);
}

// Compat aliases while file/function naming catches up.
export const overlayExternalOAuthProfiles = overlayExternalAuthProfiles;
export const shouldPersistExternalOAuthProfile = shouldPersistExternalAuthProfile;
