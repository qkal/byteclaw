import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoice,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders,
}));

import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolvePluginProviders.mockReturnValue([]);
    resolveProviderPluginChoice.mockReturnValue(null);
  });

  it("prefers manifest metadata when available", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      choiceId: "openai-api-key",
      choiceLabel: "OpenAI API key",
      methodId: "api-key",
      pluginId: "openai",
      providerId: "openai",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "openai-api-key" })).resolves.toBe(
      "openai",
    );
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("normalizes legacy auth choices before plugin lookup", async () => {
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
      methodId: "cli",
      pluginId: "anthropic",
      providerId: "anthropic",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "claude-cli" })).resolves.toBe(
      "anthropic",
    );
    expect(resolveProviderPluginChoice).not.toHaveBeenCalled();
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("passes explicit env through legacy auth normalization", async () => {
    const env = { OPENCLAW_AUTH_CHOICE_TEST: "1" } as NodeJS.ProcessEnv;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
      methodId: "cli",
      pluginId: "anthropic",
      providerId: "anthropic",
    });

    await expect(
      resolvePreferredProviderForAuthChoice({ choice: "claude-cli", env }),
    ).resolves.toBe("anthropic");
    expect(resolveManifestDeprecatedProviderAuthChoice).toHaveBeenCalledWith("claude-cli", { env });
  });

  it("uses manifest metadata for plugin-owned choices", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      choiceId: "chutes",
      choiceLabel: "Chutes OAuth",
      methodId: "oauth",
      pluginId: "chutes",
      providerId: "chutes",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "chutes" })).resolves.toBe(
      "chutes",
    );
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("passes untrusted-workspace filtering through setup-provider fallback lookup", async () => {
    resolvePluginProviders.mockReturnValue([
      {
        auth: [{ id: "api-key", kind: "api_key", label: "API key" }],
        id: "demo-provider",
        label: "Demo Provider",
      },
    ] as never);
    resolveProviderPluginChoice.mockReturnValue({
      method: { id: "api-key" },
      provider: { id: "demo-provider" },
    });

    await expect(
      resolvePreferredProviderForAuthChoice({
        choice: "demo-provider",
        includeUntrustedWorkspacePlugins: false,
      }),
    ).resolves.toBe("demo-provider");
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
        mode: "setup",
      }),
    );
  });
});
