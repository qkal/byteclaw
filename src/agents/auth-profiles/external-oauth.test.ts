import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const resolveExternalAuthProfilesWithPluginsMock = vi.fn<
  (params: unknown) => ProviderExternalAuthProfile[]
>(() => []);

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: (params: unknown) =>
    resolveExternalAuthProfilesWithPluginsMock(params),
  resolveExternalOAuthProfilesWithPlugins: (params: unknown) =>
    resolveExternalAuthProfilesWithPluginsMock(params),
}));

function createStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return { profiles, version: 1 };
}

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    access: "access-token",
    expires: 123,
    provider: "openai-codex",
    refresh: "refresh-token",
    type: "oauth",
    ...overrides,
  };
}

describe("auth external oauth helpers", () => {
  beforeEach(() => {
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
  });

  it("overlays provider-managed runtime oauth profiles onto the store", async () => {
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        credential: createCredential(),
        profileId: "openai-codex:default",
      },
    ]);

    const { overlayExternalOAuthProfiles } = await import("./external-auth.js");
    const store = overlayExternalOAuthProfiles(createStore());

    expect(store.profiles["openai-codex:default"]).toMatchObject({
      access: "access-token",
      provider: "openai-codex",
      type: "oauth",
    });
  });

  it("omits exact runtime-only overlays from persisted store writes", async () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        credential,
        profileId: "openai-codex:default",
      },
    ]);

    const { shouldPersistExternalOAuthProfile } = await import("./external-auth.js");
    const shouldPersist = shouldPersistExternalOAuthProfile({
      credential,
      profileId: "openai-codex:default",
      store: createStore({ "openai-codex:default": credential }),
    });

    expect(shouldPersist).toBe(false);
  });

  it("keeps persisted copies when the external overlay is marked persisted", async () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        credential,
        persistence: "persisted",
        profileId: "openai-codex:default",
      },
    ]);

    const { shouldPersistExternalOAuthProfile } = await import("./external-auth.js");
    const shouldPersist = shouldPersistExternalOAuthProfile({
      credential,
      profileId: "openai-codex:default",
      store: createStore({ "openai-codex:default": credential }),
    });

    expect(shouldPersist).toBe(true);
  });

  it("keeps stale local copies when runtime overlay no longer matches", async () => {
    const credential = createCredential();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValueOnce([
      {
        credential: createCredential({ access: "fresh-access-token" }),
        profileId: "openai-codex:default",
      },
    ]);

    const { shouldPersistExternalOAuthProfile } = await import("./external-auth.js");
    const shouldPersist = shouldPersistExternalOAuthProfile({
      credential,
      profileId: "openai-codex:default",
      store: createStore({ "openai-codex:default": credential }),
    });

    expect(shouldPersist).toBe(true);
  });
});
