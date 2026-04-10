import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

function createGoogleModel(id: string): ModelDefinitionConfig {
  return {
    api: "google-generative-ai",
    contextWindow: 1_048_576,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text", "image"],
    maxTokens: 65_536,
    name: id,
    reasoning: id.includes("pro"),
  };
}

function buildGoogleProvider(
  modelIds: string[],
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "GEMINI_KEY", // Pragma: allowlist secret
    api: "google-generative-ai",
    models: modelIds.map((id) => createGoogleModel(id)),
    ...overrides,
  } satisfies ProviderConfig;
}

function normalizeForTest(providers: Record<string, ProviderConfig>) {
  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-models-normalize-"));
  return normalizeProviders({ agentDir, providers }) ?? {};
}

function normalizedModelIds(provider: ProviderConfig | undefined): string[] {
  return provider?.models?.map((model) => model.id) ?? [];
}

describe("models-config", () => {
  it("normalizes gemini 3 ids to preview for google providers", () => {
    const normalized = normalizeForTest({
      google: buildGoogleProvider(["gemini-3-pro", "gemini-3-flash"]),
    });

    expect(normalizedModelIds(normalized.google)).toEqual([
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
    ]);
  });

  it("normalizes the deprecated google flash preview id to the working preview id", () => {
    const normalized = normalizeForTest({
      google: buildGoogleProvider(["gemini-3.1-flash-preview"]),
    });

    expect(normalizedModelIds(normalized.google)).toEqual(["gemini-3-flash-preview"]);
  });

  it("normalizes custom Google Generative AI providers by api instead of provider name", () => {
    const normalized = normalizeForTest({
      "google-paid": buildGoogleProvider(["gemini-3-pro"]),
    });

    expect(normalizedModelIds(normalized["google-paid"])).toEqual(["gemini-3-pro-preview"]);
    expect(normalized["google-paid"]?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("keeps built-in google normalization when api is only defined on models", () => {
    const normalized = normalizeForTest({
      google: buildGoogleProvider(["gemini-3-flash"], { api: undefined }),
    });

    expect(normalizedModelIds(normalized.google)).toEqual(["gemini-3-flash-preview"]);
    expect(normalized.google?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });
});
