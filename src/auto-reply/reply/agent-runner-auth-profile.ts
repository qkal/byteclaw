import type { FollowupRun } from "./queue.js";

export function resolveProviderScopedAuthProfile(params: {
  provider: string;
  primaryProvider: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
}): { authProfileId?: string; authProfileIdSource?: "auto" | "user" } {
  const authProfileId =
    params.provider === params.primaryProvider ? params.authProfileId : undefined;
  return {
    authProfileId,
    authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
  };
}

export function resolveRunAuthProfile(run: FollowupRun["run"], provider: string) {
  return resolveProviderScopedAuthProfile({
    authProfileId: run.authProfileId,
    authProfileIdSource: run.authProfileIdSource,
    primaryProvider: run.provider,
    provider,
  });
}
