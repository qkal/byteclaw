import {
  type OAuthCredentials,
  type OAuthProvider,
  getOAuthApiKey,
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { type SecretRefResolveCache, resolveSecretRefString } from "../../secrets/resolve.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { writeCodexCliCredentials } from "../cli-credentials.js";
import { AUTH_STORE_LOCK_OPTIONS, log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import {
  areOAuthCredentialsEquivalent,
  readManagedExternalCliCredential,
} from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function listOAuthProviderIds(): string[] {
  if (typeof getOAuthProviders !== "function") {
    return [];
  }
  const providers = getOAuthProviders();
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((provider) =>
      provider &&
      typeof provider === "object" &&
      "id" in provider &&
      typeof provider.id === "string"
        ? provider.id
        : undefined,
    )
    .filter((providerId): providerId is string => typeof providerId === "string");
}

const OAUTH_PROVIDER_IDS = new Set<string>(listOAuthProviderIds());

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(provider: string, credentials: OAuthCredential): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    context: credentials,
    provider,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    email: params.email,
    provider: params.provider,
  };
}

async function buildOAuthProfileResult(params: {
  provider: string;
  credentials: OAuthCredential;
  email?: string;
}) {
  return buildApiKeyProfileResult({
    apiKey: await buildOAuthApiKey(params.provider, params.credentials),
    email: params.email,
    provider: params.provider,
  });
}

function extractErrorMessage(error: unknown): string {
  return formatErrorMessage(error);
}

function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
}

function hasOAuthCredentialChanged(
  previous: Pick<OAuthCredential, "access" | "refresh" | "expires">,
  current: Pick<OAuthCredential, "access" | "refresh" | "expires">,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

async function loadFreshStoredOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  previous?: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  requireChange?: boolean;
}): Promise<OAuthCredential | null> {
  const reloadedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const reloaded = reloadedStore.profiles[params.profileId];
  if (reloaded?.type !== "oauth" || reloaded.provider !== params.provider) {
    return null;
  }
  if (!Number.isFinite(reloaded.expires) || Date.now() >= reloaded.expires) {
    return null;
  }
  if (
    params.requireChange &&
    params.previous &&
    !hasOAuthCredentialChanged(params.previous, reloaded)
  ) {
    return null;
  }
  return reloaded;
}

interface ResolveApiKeyForProfileParams {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): (OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      mainCred.provider === params.cred.provider &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires)
    ) {
      params.store.profiles[params.profileId] = { ...mainCred };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from main agent", {
        agentDir: params.agentDir,
        expires: new Date(mainCred.expires).toISOString(),
        profileId: params.profileId,
      });
      return mainCred;
    }
  } catch (error) {
    // Best-effort: don't crash if main agent store is missing or unreadable.
    log.debug("adoptNewerMainOAuthCredential failed", {
      error: formatErrorMessage(error),
      profileId: params.profileId,
    });
  }
  return null;
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
    // Locked refresh must bypass runtime snapshots so we can adopt fresher
    // On-disk credentials written by another refresh attempt.
    const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") {
      return null;
    }

    if (Date.now() < cred.expires) {
      return {
        apiKey: await buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
      };
    }

    const externallyManaged = readManagedExternalCliCredential({
      credential: cred,
      profileId: params.profileId,
    });
    if (externallyManaged) {
      if (!areOAuthCredentialsEquivalent(cred, externallyManaged)) {
        store.profiles[params.profileId] = externallyManaged;
        saveAuthProfileStore(store, params.agentDir);
      }
      if (Date.now() < externallyManaged.expires) {
        return {
          apiKey: await buildOAuthApiKey(externallyManaged.provider, externallyManaged),
          newCredentials: externallyManaged,
        };
      }
      if (externallyManaged.managedBy === "codex-cli") {
        const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
          context: externallyManaged,
          provider: externallyManaged.provider,
        });
        if (pluginRefreshed) {
          const refreshedCredentials: OAuthCredential = {
            ...externallyManaged,
            ...pluginRefreshed,
            managedBy: "codex-cli",
            type: "oauth",
          };
          if (!writeCodexCliCredentials(refreshedCredentials)) {
            log.warn("failed to persist refreshed codex credentials back to Codex storage", {
              profileId: params.profileId,
            });
          }
          store.profiles[params.profileId] = refreshedCredentials;
          saveAuthProfileStore(store, params.agentDir);
          return {
            apiKey: await buildOAuthApiKey(refreshedCredentials.provider, refreshedCredentials),
            newCredentials: refreshedCredentials,
          };
        }
      }
      throw new Error(
        `${externallyManaged.managedBy} credential is expired; refresh it in the external CLI and retry.`,
      );
    }
    if (cred.managedBy) {
      throw new Error(
        `${cred.managedBy} credential is unavailable; re-authenticate in the external CLI and retry.`,
      );
    }

    const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
      context: cred,
      provider: cred.provider,
    });
    if (pluginRefreshed) {
      const refreshedCredentials: OAuthCredential = {
        ...cred,
        ...pluginRefreshed,
        type: "oauth",
      };
      store.profiles[params.profileId] = refreshedCredentials;
      saveAuthProfileStore(store, params.agentDir);
      return {
        apiKey: await buildOAuthApiKey(cred.provider, refreshedCredentials),
        newCredentials: refreshedCredentials,
      };
    }

    const oauthCreds: Record<string, OAuthCredentials> = { [cred.provider]: cred };
    const result =
      String(cred.provider) === "chutes"
        ? await (async () => {
            const newCredentials = await refreshChutesTokens({
              credential: cred,
            });
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : await (async () => {
            const oauthProvider = resolveOAuthProvider(cred.provider);
            if (!oauthProvider) {
              return null;
            }
            if (typeof getOAuthApiKey !== "function") {
              return null;
            }
            return await getOAuthApiKey(oauthProvider, oauthCreds);
          })();
    if (!result) {
      return null;
    }
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store, params.agentDir);

    return result;
  });
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      mode: cred.type,
      profileId,
      provider: cred.provider,
    })
  ) {
    return null;
  }

  if (Date.now() < cred.expires) {
    return await buildOAuthProfileResult({
      credentials: cred,
      email: cred.email,
      provider: cred.provider,
    });
  }

  const refreshed = await refreshOAuthTokenWithLock({
    agentDir: params.agentDir,
    profileId,
  });
  if (!refreshed) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: refreshed.apiKey,
    email: cred.email,
    provider: cred.provider,
  });
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          cache: params.cache,
          config: params.configForRefResolution,
          env: process.env,
        });
      } catch (error) {
        log.debug(params.inlineFailureMessage, {
          error: formatErrorMessage(error),
          profileId: params.profileId,
          provider: params.provider,
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        cache: params.cache,
        config: params.configForRefResolution,
        env: process.env,
      });
    } catch (error) {
      log.debug(params.refFailureMessage, {
        error: formatErrorMessage(error),
        profileId: params.profileId,
        provider: params.provider,
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? loadConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  assertNoOAuthSecretRefPolicyViolations({
    cfg: configForRefResolution,
    context: `auth profile ${profileId}`,
    profileIds: [profileId],
    store,
  });

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      cache: refResolveCache,
      configForRefResolution,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      profileId,
      provider: cred.provider,
      refDefaults,
      refFailureMessage: "failed to resolve auth profile api_key ref",
      value: cred.key,
      valueRef: cred.keyRef,
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, email: cred.email, provider: cred.provider });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      cache: refResolveCache,
      configForRefResolution,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      profileId,
      provider: cred.provider,
      refDefaults,
      refFailureMessage: "failed to resolve auth profile token ref",
      value: cred.token,
      valueRef: cred.tokenRef,
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, email: cred.email, provider: cred.provider });
  }

  const oauthCred =
    adoptNewerMainOAuthCredential({
      agentDir: params.agentDir,
      cred,
      profileId,
      store,
    }) ?? cred;

  if (Date.now() < oauthCred.expires) {
    return await buildOAuthProfileResult({
      credentials: oauthCred,
      email: oauthCred.email,
      provider: oauthCred.provider,
    });
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      agentDir: params.agentDir,
      profileId,
    });
    if (!result) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      email: cred.email,
      provider: cred.provider,
    });
  } catch (error) {
    const refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return await buildOAuthProfileResult({
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
        provider: refreshed.provider,
      });
    }
    if (
      isRefreshTokenReusedError(error) &&
      refreshed?.type === "oauth" &&
      refreshed.provider === cred.provider &&
      hasOAuthCredentialChanged(cred, refreshed)
    ) {
      const recovered = await loadFreshStoredOAuthCredential({
        agentDir: params.agentDir,
        previous: cred,
        profileId,
        provider: cred.provider,
        requireChange: true,
      });
      if (recovered) {
        return await buildOAuthProfileResult({
          credentials: recovered,
          email: recovered.email ?? cred.email,
          provider: recovered.provider,
        });
      }
      const retried = await refreshOAuthTokenWithLock({
        agentDir: params.agentDir,
        profileId,
      });
      if (retried) {
        return buildApiKeyProfileResult({
          apiKey: retried.apiKey,
          email: cred.email,
          provider: cred.provider,
        });
      }
    }
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      legacyProfileId: profileId,
      provider: cred.provider,
      store: refreshedStore,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          agentDir: params.agentDir,
          cfg,
          profileId: fallbackProfileId,
          store: refreshedStore,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // Keep original error
      }
    }

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // Main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (mainCred?.type === "oauth" && Date.now() < mainCred.expires) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
            profileId,
          });
          return await buildOAuthProfileResult({
            credentials: mainCred,
            email: mainCred.email,
            provider: mainCred.provider,
          });
        }
      } catch {
        // Keep original error if main agent fallback also fails
      }
    }

    const message = extractErrorMessage(error);
    const hint = await formatAuthDoctorHint({
      cfg,
      profileId,
      provider: cred.provider,
      store: refreshedStore,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
