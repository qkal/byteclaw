import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  resolveAuthProfileDisplayLabel: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveEnvApiKey: vi.fn(() => null),
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
}));

vi.mock("./model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKey,
}));

let resolveModelAuthLabel: typeof import("./model-auth-label.js").resolveModelAuthLabel;

describe("resolveModelAuthLabel", () => {
  beforeEach(async () => {
    if (!resolveModelAuthLabel) {
      ({ resolveModelAuthLabel } = await import("./model-auth-label.js"));
    }
    mocks.ensureAuthProfileStore.mockReset();
    mocks.resolveAuthProfileOrder.mockReset();
    mocks.resolveAuthProfileDisplayLabel.mockReset();
    mocks.resolveUsableCustomProviderApiKey.mockReset();
    mocks.resolveUsableCustomProviderApiKey.mockReturnValue(null);
    mocks.resolveEnvApiKey.mockReset();
    mocks.resolveEnvApiKey.mockReturnValue(null);
  });

  it("does not include token value in label for token profiles", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // Pragma: allowlist secret
          tokenRef: { id: "GITHUB_TOKEN", provider: "default", source: "env" },
        },
      },
      version: 1,
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["github-copilot:default"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("github-copilot:default");

    const label = resolveModelAuthLabel({
      cfg: {},
      provider: "github-copilot",
      sessionEntry: { authProfileOverride: "github-copilot:default" } as never,
    });

    expect(label).toBe("token (github-copilot:default)");
    expect(label).not.toContain("ghp_");
    expect(label).not.toContain("ref(");
  });

  it("does not include api-key value in label for api-key profiles", () => {
    const shortSecret = "abc123"; // Pragma: allowlist secret
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai:default": {
          key: shortSecret,
          provider: "openai",
          type: "api_key",
        },
      },
      version: 1,
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("openai:default");

    const label = resolveModelAuthLabel({
      cfg: {},
      provider: "openai",
      sessionEntry: { authProfileOverride: "openai:default" } as never,
    });

    expect(label).toBe("api-key (openai:default)");
    expect(label).not.toContain(shortSecret);
    expect(label).not.toContain("...");
  });

  it("shows oauth type with profile label", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "anthropic:oauth": {
          provider: "anthropic",
          type: "oauth",
        },
      },
      version: 1,
    } as never);
    mocks.resolveAuthProfileOrder.mockReturnValue(["anthropic:oauth"]);
    mocks.resolveAuthProfileDisplayLabel.mockReturnValue("anthropic:oauth");

    const label = resolveModelAuthLabel({
      cfg: {},
      provider: "anthropic",
      sessionEntry: { authProfileOverride: "anthropic:oauth" } as never,
    });

    expect(label).toBe("oauth (anthropic:oauth)");
  });
});
