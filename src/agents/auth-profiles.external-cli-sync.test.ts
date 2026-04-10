import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn<() => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<() => OAuthCredential | null>(() => null),
}));

let syncExternalCliCredentials: typeof import("./auth-profiles/external-cli-sync.js").syncExternalCliCredentials;
let shouldReplaceStoredOAuthCredential: typeof import("./auth-profiles/external-cli-sync.js").shouldReplaceStoredOAuthCredential;
let CODEX_CLI_PROFILE_ID: typeof import("./auth-profiles/constants.js").CODEX_CLI_PROFILE_ID;
let OPENAI_CODEX_DEFAULT_PROFILE_ID: typeof import("./auth-profiles/constants.js").OPENAI_CODEX_DEFAULT_PROFILE_ID;
let MINIMAX_CLI_PROFILE_ID: typeof import("./auth-profiles/constants.js").MINIMAX_CLI_PROFILE_ID;

function makeOAuthCredential(
  overrides: Partial<OAuthCredential> & Pick<OAuthCredential, "provider">,
) {
  return {
    access: overrides.access ?? `${overrides.provider}-access`,
    accountId: overrides.accountId,
    email: overrides.email,
    enterpriseUrl: overrides.enterpriseUrl,
    expires: overrides.expires ?? Date.now() + 60_000,
    projectId: overrides.projectId,
    provider: overrides.provider,
    refresh: overrides.refresh ?? `${overrides.provider}-refresh`,
    type: "oauth" as const,
  };
}

function makeStore(profileId?: string, credential?: OAuthCredential): AuthProfileStore {
  return {
    profiles: profileId && credential ? { [profileId]: credential } : {},
    version: 1,
  };
}

function getProviderCases() {
  return [
    {
      label: "Codex",
      legacyProfileId: CODEX_CLI_PROFILE_ID,
      profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
      provider: "openai-codex" as const,
      readMock: mocks.readCodexCliCredentialsCached,
    },
    {
      label: "MiniMax",
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal" as const,
      readMock: mocks.readMiniMaxCliCredentialsCached,
    },
  ];
}

describe("syncExternalCliCredentials", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("./auth-profiles/external-cli-sync.js");
    mocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
    vi.doMock("./cli-credentials.js", () => ({
      readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
      readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
    }));
    ({ syncExternalCliCredentials, shouldReplaceStoredOAuthCredential } =
      await import("./auth-profiles/external-cli-sync.js"));
    ({ CODEX_CLI_PROFILE_ID, OPENAI_CODEX_DEFAULT_PROFILE_ID, MINIMAX_CLI_PROFILE_ID } =
      await import("./auth-profiles/constants.js"));
  });

  describe("shouldReplaceStoredOAuthCredential", () => {
    it("keeps equivalent stored credentials", () => {
      const expires = Date.now() + 60_000;
      const stored = makeOAuthCredential({
        access: "a",
        expires,
        provider: "openai-codex",
        refresh: "r",
      });
      const incoming = makeOAuthCredential({
        access: "a",
        expires,
        provider: "openai-codex",
        refresh: "r",
      });

      expect(shouldReplaceStoredOAuthCredential(stored, incoming)).toBe(false);
    });

    it("keeps the newer stored credential", () => {
      const incoming = makeOAuthCredential({
        expires: Date.now() + 60_000,
        provider: "openai-codex",
      });
      const stored = makeOAuthCredential({
        access: "fresh-access",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        provider: "openai-codex",
        refresh: "fresh-refresh",
      });

      expect(shouldReplaceStoredOAuthCredential(stored, incoming)).toBe(false);
    });

    it("replaces when incoming credentials are fresher", () => {
      const stored = makeOAuthCredential({
        expires: Date.now() + 60_000,
        provider: "openai-codex",
      });
      const incoming = makeOAuthCredential({
        access: "new-access",
        expires: Date.now() + 5 * 24 * 60 * 60_000,
        provider: "openai-codex",
        refresh: "new-refresh",
      });

      expect(shouldReplaceStoredOAuthCredential(stored, incoming)).toBe(true);
      expect(shouldReplaceStoredOAuthCredential(undefined, incoming)).toBe(true);
    });
  });

  it.each([{ providerLabel: "Codex" }, { providerLabel: "MiniMax" }])(
    "syncs $providerLabel CLI credentials into the target auth profile",
    ({ providerLabel }) => {
      const providerCase = getProviderCases().find((entry) => entry.label === providerLabel);
      expect(providerCase).toBeDefined();
      const current = providerCase!;
      const expires = Date.now() + 60_000;
      current.readMock.mockReturnValue(
        makeOAuthCredential({
          access: `${current.provider}-access-token`,
          accountId: "acct_123",
          expires,
          provider: current.provider,
          refresh: `${current.provider}-refresh-token`,
        }),
      );

      const store = makeStore();

      const mutated = syncExternalCliCredentials(store);

      expect(mutated).toBe(true);
      expect(current.readMock).toHaveBeenCalledWith(
        expect.objectContaining({ ttlMs: expect.any(Number) }),
      );
      expect(store.profiles[current.profileId]).toMatchObject({
        access: `${current.provider}-access-token`,
        accountId: "acct_123",
        expires,
        managedBy: current.provider === "openai-codex" ? "codex-cli" : ("minimax-cli" as const),
        provider: current.provider,
        refresh: `${current.provider}-refresh-token`,
        type: "oauth",
      });
      if (current.legacyProfileId) {
        expect(store.profiles[current.legacyProfileId]).toBeUndefined();
      }
    },
  );

  it("refreshes stored Codex expiry from external CLI even when the cached profile looks fresh", () => {
    const staleExpiry = Date.now() + 30 * 60_000;
    const freshExpiry = Date.now() + 5 * 24 * 60 * 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        access: "new-access-token",
        accountId: "acct_456",
        expires: freshExpiry,
        provider: "openai-codex",
        refresh: "new-refresh-token",
      }),
    );

    const store = makeStore(
      OPENAI_CODEX_DEFAULT_PROFILE_ID,
      makeOAuthCredential({
        access: "old-access-token",
        accountId: "acct_456",
        expires: staleExpiry,
        provider: "openai-codex",
        refresh: "old-refresh-token",
      }),
    );

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      access: "new-access-token",
      expires: freshExpiry,
      managedBy: "codex-cli",
      refresh: "new-refresh-token",
    });
  });

  it.each([{ providerLabel: "Codex" }, { providerLabel: "MiniMax" }])(
    "does not overwrite newer stored $providerLabel credentials",
    ({ providerLabel }) => {
      const providerCase = getProviderCases().find((entry) => entry.label === providerLabel);
      expect(providerCase).toBeDefined();
      const current = providerCase!;
      const staleExpiry = Date.now() + 30 * 60_000;
      const freshExpiry = Date.now() + 5 * 24 * 60 * 60_000;
      current.readMock.mockReturnValue(
        makeOAuthCredential({
          access: `stale-${current.provider}-access-token`,
          accountId: "acct_789",
          expires: staleExpiry,
          provider: current.provider,
          refresh: `stale-${current.provider}-refresh-token`,
        }),
      );

      const store = makeStore(
        current.profileId,
        makeOAuthCredential({
          access: `fresh-${current.provider}-access-token`,
          accountId: "acct_789",
          expires: freshExpiry,
          provider: current.provider,
          refresh: `fresh-${current.provider}-refresh-token`,
        }),
      );

      const mutated = syncExternalCliCredentials(store);

      expect(mutated).toBe(false);
      expect(store.profiles[current.profileId]).toMatchObject({
        access: `fresh-${current.provider}-access-token`,
        expires: freshExpiry,
        refresh: `fresh-${current.provider}-refresh-token`,
      });
    },
  );

  it("upgrades matching Codex CLI credentials with external ownership metadata", () => {
    const expires = Date.now() + 60_000;
    mocks.readCodexCliCredentialsCached.mockReturnValue(
      makeOAuthCredential({
        access: "same-access-token",
        expires,
        provider: "openai-codex",
        refresh: "same-refresh-token",
      }),
    );

    const store = makeStore(
      OPENAI_CODEX_DEFAULT_PROFILE_ID,
      makeOAuthCredential({
        access: "same-access-token",
        expires,
        provider: "openai-codex",
        refresh: "same-refresh-token",
      }),
    );

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      access: "same-access-token",
      expires,
      managedBy: "codex-cli",
      refresh: "same-refresh-token",
    });
  });
});
