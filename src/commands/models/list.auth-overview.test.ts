import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

function resolveOpenAiOverview(apiKey: string) {
  return resolveProviderAuthOverview({
    cfg: {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            apiKey,
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    } as never,
    modelsPath: "/tmp/models.json",
    provider: "openai",
    store: { profiles: {}, version: 1 } as never,
  });
}

describe("resolveProviderAuthOverview", () => {
  it("does not throw when token profile only has tokenRef", () => {
    const overview = resolveProviderAuthOverview({
      cfg: {},
      modelsPath: "/tmp/models.json",
      provider: "github-copilot",
      store: {
        profiles: {
          "github-copilot:default": {
            provider: "github-copilot",
            tokenRef: { id: "GITHUB_TOKEN", provider: "default", source: "env" },
            type: "token",
          },
        },
        version: 1,
      } as never,
    });

    expect(overview.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
  });

  it("renders marker-backed models.json auth as marker detail", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview(NON_ENV_SECRETREF_MARKER),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).toContain(`marker(${NON_ENV_SECRETREF_MARKER})`);
  });

  it("keeps env-var-shaped models.json values masked to avoid accidental plaintext exposure", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview("OPENAI_API_KEY"),
    );

    expect(overview.effective.kind).toBe("missing");
    expect(overview.effective.detail).toBe("missing");
    expect(overview.modelsJson?.value).not.toContain("marker(");
    expect(overview.modelsJson?.value).not.toContain("OPENAI_API_KEY");
  });

  it("treats env-var marker as usable only when the env key is currently resolvable", () => {
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-from-env"; // Pragma: allowlist secret
    try {
      const overview = resolveOpenAiOverview("OPENAI_API_KEY");
      expect(overview.effective.kind).toBe("env");
      expect(overview.effective.detail).not.toContain("OPENAI_API_KEY");
    } finally {
      if (prior === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prior;
      }
    }
  });
});
