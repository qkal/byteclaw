import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveRequestedLoginProviderOrThrow } from "./models/auth.js";

function makeProvider(params: { id: string; label?: string; aliases?: string[] }): ProviderPlugin {
  return {
    aliases: params.aliases,
    auth: [],
    id: params.id,
    label: params.label ?? params.id,
  };
}

describe("resolveRequestedLoginProviderOrThrow", () => {
  it("returns null and resolves provider by id/alias", () => {
    const providers = [
      makeProvider({ aliases: ["gemini-cli"], id: "google-gemini-cli" }),
      makeProvider({ id: "minimax-portal" }),
    ];
    const scenarios = [
      { expectedId: null, requested: undefined },
      { expectedId: "google-gemini-cli", requested: "google-gemini-cli" },
      { expectedId: "google-gemini-cli", requested: "gemini-cli" },
    ] as const;

    for (const scenario of scenarios) {
      const result = resolveRequestedLoginProviderOrThrow(providers, scenario.requested);
      expect(result?.id ?? null).toBe(scenario.expectedId);
    }
  });

  it("throws when requested provider is not loaded", () => {
    const loadedProviders = [
      makeProvider({ id: "google-gemini-cli" }),
      makeProvider({ id: "minimax-portal" }),
    ];

    expect(() =>
      resolveRequestedLoginProviderOrThrow(loadedProviders, "google-antigravity"),
    ).toThrowError(
      'Unknown provider "google-antigravity". Loaded providers: google-gemini-cli, minimax-portal. Verify plugins via `openclaw plugins list --json`.',
    );
  });
});
