import { describe, expect, it, vi } from "vitest";
import {
  type ResolveImplicitProvidersForModelsJson,
  planOpenClawModelsJson,
  planOpenClawModelsJsonWithDeps,
} from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

vi.mock("./models-config.providers.js", () => ({
  applyNativeStreamingUsageCompat: (providers: unknown) => providers,
  enforceSourceManagedProviderSecrets: ({ providers }: { providers: unknown }) => providers,
  normalizeProviders: ({ providers }: { providers: unknown }) => providers,
  resolveImplicitProviders: async ({
    explicitProviders,
  }: {
    explicitProviders?: Record<string, unknown>;
  }) => explicitProviders ?? {},
}));

describe("models-config", () => {
  it("uses the first github-copilot profile when env tokens are missing", () => {
    const auth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      profiles: {
        "github-copilot:alpha": {
          provider: "github-copilot",
          token: "alpha-token",
          type: "token",
        },
        "github-copilot:beta": {
          provider: "github-copilot",
          token: "beta-token",
          type: "token",
        },
      },
      version: 1,
    });

    expect(auth("github-copilot")).toEqual({
      apiKey: "alpha-token",
      discoveryApiKey: "alpha-token",
      mode: "token",
      profileId: "github-copilot:alpha",
      source: "profile",
    });
  });

  it("does not override explicit github-copilot provider config", async () => {
    const plan = await planOpenClawModelsJson({
      agentDir: "/tmp/openclaw-agent",
      cfg: {
        models: {
          providers: {
            "github-copilot": {
              api: "openai-responses",
              baseUrl: "https://copilot.local",
              models: [],
            },
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      existingParsed: null,
      existingRaw: "",
    });

    expect(plan.action).toBe("write");
    expect(
      plan.action === "write"
        ? (
            JSON.parse(plan.contents) as {
              providers?: Record<string, { baseUrl?: string }>;
            }
          ).providers?.["github-copilot"]?.baseUrl
        : undefined,
    ).toBe("https://copilot.local");
  });

  it("passes explicit provider config to implicit discovery so plugins can skip duplicates", async () => {
    const resolveImplicitProviders = vi.fn<ResolveImplicitProvidersForModelsJson>(
      async ({ explicitProviders }) => {
        expect(explicitProviders.vllm?.baseUrl).toBe("http://127.0.0.1:8000/v1");
        return {};
      },
    );

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        agentDir: "/tmp/openclaw-agent",
        cfg: {
          models: {
            providers: {
              vllm: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8000/v1",
                models: [],
              },
            },
          },
        },
        env: { VLLM_API_KEY: "test-vllm-key" } as NodeJS.ProcessEnv,
        existingParsed: null,
        existingRaw: "",
      },
      { resolveImplicitProviders },
    );

    expect(resolveImplicitProviders).toHaveBeenCalledOnce();
    expect(plan).toEqual({
      action: "write",
      contents: `${JSON.stringify(
        {
          providers: {
            vllm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    });
  });

  it("uses tokenRef env var when github-copilot profile omits plaintext token", () => {
    const auth = createProviderAuthResolver(
      {
        COPILOT_REF_TOKEN: "token-from-ref-env",
      } as NodeJS.ProcessEnv,
      {
        profiles: {
          "github-copilot:default": {
            provider: "github-copilot",
            tokenRef: { id: "COPILOT_REF_TOKEN", provider: "default", source: "env" },
            type: "token",
          },
        },
        version: 1,
      },
    );

    expect(auth("github-copilot")).toEqual({
      apiKey: "COPILOT_REF_TOKEN",
      discoveryApiKey: "token-from-ref-env",
      mode: "token",
      profileId: "github-copilot:default",
      source: "profile",
    });
  });

  it("writes an implicit github-copilot provider discovered from a token exchange", async () => {
    const plan = await planCopilotWithImplicitProvider({
      provider: { baseUrl: "https://api.copilot.example", models: [] },
    });

    expectCopilotProviderFromPlan(plan).toEqual({
      baseUrl: "https://api.copilot.example",
      models: [],
    });
  });

  it("writes default github-copilot baseUrl when the token exchange fails", async () => {
    const plan = await planCopilotWithImplicitProvider({
      provider: { baseUrl: "https://api.individual.githubcopilot.com", models: [] },
    });

    expectCopilotProviderFromPlan(plan)?.toEqual({
      baseUrl: "https://api.individual.githubcopilot.com",
      models: [],
    });
  });
});

function createCopilotImplicitResolver(
  provider: ProviderConfig,
): ResolveImplicitProvidersForModelsJson {
  return async () => ({ "github-copilot": provider });
}

async function planCopilotWithImplicitProvider(params: { provider: ProviderConfig }) {
  return await planOpenClawModelsJsonWithDeps(
    {
      agentDir: "/tmp/openclaw-agent",
      cfg: { models: { providers: {} } },
      env: {} as NodeJS.ProcessEnv,
      existingParsed: null,
      existingRaw: "",
    },
    {
      resolveImplicitProviders: createCopilotImplicitResolver(params.provider),
    },
  );
}

function expectCopilotProviderFromPlan(
  plan: Awaited<ReturnType<typeof planCopilotWithImplicitProvider>>,
) {
  expect(plan.action).toBe("write");
  const parsed =
    plan.action === "write"
      ? (JSON.parse(plan.contents) as { providers?: Record<string, unknown> })
      : {};
  expect(parsed.providers?.["github-copilot"]).toBeDefined();
  return expect(parsed.providers?.["github-copilot"]);
}
