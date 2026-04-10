import { afterEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resetCliAuthEpochTestDeps,
  resolveCliAuthEpoch,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.js";

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
  });

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => ({
        profiles: {},
        version: 1,
      }),
      readClaudeCliCredentialsCached: () => null,
      readCodexCliCredentialsCached: () => null,
    });

    await expect(resolveCliAuthEpoch({ provider: "claude-cli" })).resolves.toBeUndefined();
    await expect(
      resolveCliAuthEpoch({
        authProfileId: "google:work",
        provider: "google-gemini-cli",
      }),
    ).resolves.toBeUndefined();
  });

  it("changes when claude cli credentials change", async () => {
    let access = "access-a";
    setCliAuthEpochTestDeps({
      readClaudeCliCredentialsCached: () => ({
        access,
        expires: 1,
        provider: "anthropic",
        refresh: "refresh",
        type: "oauth",
      }),
    });

    const first = await resolveCliAuthEpoch({ provider: "claude-cli" });
    access = "access-b";
    const second = await resolveCliAuthEpoch({ provider: "claude-cli" });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("changes when auth profile credentials change", async () => {
    let store: AuthProfileStore = {
      profiles: {
        "anthropic:work": {
          access: "access-a",
          expires: 1,
          provider: "anthropic",
          refresh: "refresh",
          type: "oauth",
        },
      },
      version: 1,
    };
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => store,
    });

    const first = await resolveCliAuthEpoch({
      authProfileId: "anthropic:work",
      provider: "google-gemini-cli",
    });
    store = {
      profiles: {
        "anthropic:work": {
          access: "access-b",
          expires: 1,
          provider: "anthropic",
          refresh: "refresh",
          type: "oauth",
        },
      },
      version: 1,
    };
    const second = await resolveCliAuthEpoch({
      authProfileId: "anthropic:work",
      provider: "google-gemini-cli",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("mixes local codex and auth-profile state", async () => {
    let access = "local-access-a";
    let refresh = "profile-refresh-a";
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => ({
        profiles: {
          "openai:work": {
            access: "profile-access",
            expires: 1,
            provider: "openai",
            refresh,
            type: "oauth",
          },
        },
        version: 1,
      }),
      readCodexCliCredentialsCached: () => ({
        access,
        accountId: "acct-1",
        expires: 1,
        provider: "openai-codex",
        refresh: "local-refresh",
        type: "oauth",
      }),
    });

    const first = await resolveCliAuthEpoch({
      authProfileId: "openai:work",
      provider: "codex-cli",
    });
    access = "local-access-b";
    const second = await resolveCliAuthEpoch({
      authProfileId: "openai:work",
      provider: "codex-cli",
    });
    refresh = "profile-refresh-b";
    const third = await resolveCliAuthEpoch({
      authProfileId: "openai:work",
      provider: "codex-cli",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
  });
});
