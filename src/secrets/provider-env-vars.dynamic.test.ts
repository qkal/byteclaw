import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockManifestRegistry {
  plugins: {
    id: string;
    origin: string;
    providerAuthEnvVars?: Record<string, string[]>;
    providerAuthAliases?: Record<string, string>;
  }[];
  diagnostics: unknown[];
}

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({ diagnostics: [], plugins: [] })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

describe("provider env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthAliases: {
            "fireworks-plan": "fireworks",
          },
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
        },
      ],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(mod.getProviderEnvVars("fireworks-plan")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(mod.listKnownProviderAuthEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
    expect(mod.listKnownSecretEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
  });
});
