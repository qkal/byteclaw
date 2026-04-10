import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNonInteractiveApiKey } from "./api-keys.js";

const resolveEnvApiKey = vi.hoisted(() => vi.fn());
vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey,
}));

const authStore = vi.hoisted(
  () =>
    ({
      profiles: {} as Record<string, { type: "api_key"; provider: string; key: string }>,
      version: 1,
    }) as const,
);
const resolveApiKeyForProfile = vi.hoisted(() =>
  vi.fn(async (params: { profileId: string }) => {
    const profile = authStore.profiles[params.profileId];
    return profile?.type === "api_key" ? { apiKey: profile.key, source: "profile" } : null;
  }),
);
vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(() => authStore),
  resolveApiKeyForProfile,
  resolveAuthProfileOrder: vi.fn(() => Object.keys(authStore.profiles)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  for (const profileId of Object.keys(authStore.profiles)) {
    delete authStore.profiles[profileId];
  }
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("resolveNonInteractiveApiKey", () => {
  it("returns explicit flag keys before resolving env or plugin-backed setup", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockImplementation(() => {
      throw new Error("env lookup should not run for an explicit plaintext flag");
    });

    const result = await resolveNonInteractiveApiKey({
      cfg: {},
      envVar: "XAI_API_KEY",
      flagName: "--xai-api-key",
      flagValue: "xai-flag-key",
      provider: "xai",
      runtime: runtime as never,
    });

    expect(result).toEqual({ key: "xai-flag-key", source: "flag" });
    expect(resolveEnvApiKey).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects flag input in secret-ref mode without broad env discovery", async () => {
    const runtime = createRuntime();
    resolveEnvApiKey.mockReturnValue(null);
    const previousXaiApiKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;

    try {
      const result = await resolveNonInteractiveApiKey({
        cfg: {},
        envVar: "XAI_API_KEY",
        flagName: "--xai-api-key",
        flagValue: "xai-flag-key",
        provider: "xai",
        runtime: runtime as never,
        secretInputMode: "ref",
      });

      expect(result).toBeNull();
      expect(resolveEnvApiKey).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("--secret-input-mode ref"),
      );
    } finally {
      if (previousXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previousXaiApiKey;
      }
    }
  });

  it("falls back to a matching API-key profile after flag and env are absent", async () => {
    const runtime = createRuntime();
    authStore.profiles["custom-models-custom-local:default"] = {
      key: "custom-profile-key",
      provider: "custom-models-custom-local",
      type: "api_key",
    };
    resolveEnvApiKey.mockReturnValue(null);

    const result = await resolveNonInteractiveApiKey({
      cfg: {},
      envVar: "CUSTOM_API_KEY",
      flagName: "--custom-api-key",
      provider: "custom-models-custom-local",
      runtime: runtime as never,
    });

    expect(result).toEqual({ key: "custom-profile-key", source: "profile" });
    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "custom-models-custom-local:default",
      }),
    );
  });
});
