import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderAuthResult } from "../plugins/types.js";

/** Build the standard auth result payload for OAuth-style provider login flows. */
export function buildOauthProviderAuthResult(params: {
  providerId: string;
  defaultModel: string;
  access: string;
  refresh?: string | null;
  expires?: number | null;
  email?: string | null;
  displayName?: string | null;
  profileName?: string | null;
  profilePrefix?: string;
  credentialExtra?: Record<string, unknown>;
  configPatch?: Partial<OpenClawConfig>;
  notes?: string[];
}): ProviderAuthResult {
  const email = params.email ?? undefined;
  const displayName = params.displayName ?? undefined;
  const profileId = buildAuthProfileId({
    profileName: params.profileName ?? email,
    profilePrefix: params.profilePrefix,
    providerId: params.providerId,
  });

  const credential: AuthProfileCredential = {
    access: params.access,
    provider: params.providerId,
    type: "oauth",
    ...(params.refresh ? { refresh: params.refresh } : {}),
    ...(Number.isFinite(params.expires) ? { expires: params.expires as number } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...params.credentialExtra,
  } as AuthProfileCredential;

  return {
    configPatch:
      params.configPatch ??
      ({
        agents: {
          defaults: {
            models: {
              [params.defaultModel]: {},
            },
          },
        },
      } as Partial<OpenClawConfig>),
    defaultModel: params.defaultModel,
    notes: params.notes,
    profiles: [{ credential, profileId }],
  };
}
