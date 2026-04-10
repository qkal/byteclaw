import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "./auth-choice.apply.api-providers.js";

const resolvePluginProviders = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders>(),
);

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
}));

function createProvider(params: {
  id: string;
  aliases?: string[];
  auth: {
    id: string;
    kind: ProviderPlugin["auth"][number]["kind"];
    choiceId?: string;
  }[];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.id,
    ...(params.aliases ? { aliases: params.aliases } : {}),
    auth: params.auth.map((method) => ({
      id: method.id,
      label: method.id,
      kind: method.kind,
      ...(method.choiceId ? { wizard: { choiceId: method.choiceId } } : {}),
      run: vi.fn(async () => ({ profiles: [] })),
    })),
  };
}

describe("normalizeApiKeyTokenProviderAuthChoice", () => {
  afterEach(() => {
    resolvePluginProviders.mockReset();
  });

  it("maps token provider auth through plugin token methods", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        auth: [{ choiceId: "setup-token", id: "setup-token", kind: "token" }],
        id: "anthropic",
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "token",
        tokenProvider: " anthropic ",
      }),
    ).toBe("setup-token");
  });

  it("maps apiKey provider auth through plugin api key methods and aliases", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        aliases: ["gemini"],
        auth: [{ choiceId: "gemini-api-key", id: "api-key", kind: "api_key" }],
        id: "google",
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "apiKey",
        tokenProvider: " GeMiNi ",
      }),
    ).toBe("gemini-api-key");
  });

  it("leaves the auth choice unchanged when no matching provider method exists", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        auth: [{ choiceId: "openai-api-key", id: "api-key", kind: "api_key" }],
        id: "openai",
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "token",
        tokenProvider: "openai",
      }),
    ).toBe("token");
  });
});
