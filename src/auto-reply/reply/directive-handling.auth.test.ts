import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/config.js";

let mockStore: AuthProfileStore;
let mockOrder: string[];
const githubCopilotTokenRefProfile: AuthProfileStore["profiles"][string] = {
  provider: "github-copilot",
  tokenRef: { id: "GITHUB_TOKEN", provider: "default", source: "env" },
  type: "token",
};

vi.mock("../../agents/auth-health.js", () => ({
  formatRemainingShort: () => "1h",
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  isProfileInCooldown: () => false,
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthStorePathForDisplay: () => "/tmp/auth-profiles.json",
}));

vi.mock("../../agents/model-selection.js", () => ({
  findNormalizedProviderValue: (
    values: Record<string, unknown> | undefined,
    provider: string,
  ): unknown => {
    if (!values) {
      return undefined;
    }
    return Object.entries(values).find(
      ([key]) => key.toLowerCase() === provider.toLowerCase(),
    )?.[1];
  },
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  ensureAuthProfileStore: () => mockStore,
  resolveAuthProfileOrder: () => mockOrder,
  resolveEnvApiKey: () => null,
  resolveUsableCustomProviderApiKey: () => null,
}));

const { resolveAuthLabel } = await import("./directive-handling.auth.js");

async function resolveRefOnlyAuthLabel(params: {
  provider: string;
  profileId: string;
  profile:
    | (AuthProfileStore["profiles"][string] & { type: "api_key" })
    | (AuthProfileStore["profiles"][string] & { type: "token" });
  mode: "compact" | "verbose";
}) {
  mockStore.profiles = {
    [params.profileId]: params.profile,
  };
  mockOrder = [params.profileId];

  return resolveAuthLabel(
    params.provider,
    {} as OpenClawConfig,
    "/tmp/models.json",
    undefined,
    params.mode,
  );
}

describe("resolveAuthLabel ref-aware labels", () => {
  beforeEach(() => {
    mockStore = {
      profiles: {},
      version: 1,
    };
    mockOrder = [];
  });

  it("shows api-key (ref) for keyRef-only profiles in compact mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      mode: "compact",
      profile: {
        keyRef: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
        provider: "openai",
        type: "api_key",
      },
      profileId: "openai:default",
      provider: "openai",
    });

    expect(result.label).toBe("openai:default api-key (ref)");
  });

  it("shows token (ref) for tokenRef-only profiles in compact mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      mode: "compact",
      profile: githubCopilotTokenRefProfile,
      profileId: "github-copilot:default",
      provider: "github-copilot",
    });

    expect(result.label).toBe("github-copilot:default token (ref)");
  });

  it("uses token:ref instead of token:missing in verbose mode", async () => {
    const result = await resolveRefOnlyAuthLabel({
      mode: "verbose",
      profile: githubCopilotTokenRefProfile,
      profileId: "github-copilot:default",
      provider: "github-copilot",
    });

    expect(result.label).toContain("github-copilot:default=token:ref");
    expect(result.label).not.toContain("token:missing");
  });
});
