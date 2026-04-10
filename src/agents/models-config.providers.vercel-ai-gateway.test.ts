import { beforeAll, describe, expect, it, vi } from "vitest";

let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;

async function loadModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [markersModule, secretsModule] = await Promise.all([
    import("./model-auth-markers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  ({ NON_ENV_SECRETREF_MARKER } = markersModule);
  ({ createProviderAuthResolver } = secretsModule);
}

beforeAll(loadModules);

describe("vercel-ai-gateway provider resolution", () => {
  it("resolves AI_GATEWAY_API_KEY through provider auth lookup", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        AI_GATEWAY_API_KEY: "vercel-gateway-test-key", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { profiles: {}, version: 1 },
    );

    expect(resolveAuth("vercel-ai-gateway")).toMatchObject({
      apiKey: "AI_GATEWAY_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("prefers env keyRef markers over runtime plaintext in auth profiles", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      profiles: {
        "vercel-ai-gateway:default": {
          key: "sk-runtime-vercel",
          keyRef: { id: "AI_GATEWAY_API_KEY", provider: "default", source: "env" },
          provider: "vercel-ai-gateway",
          type: "api_key",
        },
      },
      version: 1,
    });

    expect(resolveAuth("vercel-ai-gateway")).toMatchObject({
      apiKey: "AI_GATEWAY_API_KEY",
      mode: "api_key",
      profileId: "vercel-ai-gateway:default",
      source: "profile",
    });
  });

  it("uses non-env markers for non-env keyRef vercel profiles", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      profiles: {
        "vercel-ai-gateway:default": {
          key: "sk-runtime-vercel",
          keyRef: { id: "/vercel/ai-gateway/api-key", provider: "vault", source: "file" },
          provider: "vercel-ai-gateway",
          type: "api_key",
        },
      },
      version: 1,
    });

    expect(resolveAuth("vercel-ai-gateway")).toMatchObject({
      apiKey: NON_ENV_SECRETREF_MARKER,
      mode: "api_key",
      profileId: "vercel-ai-gateway:default",
      source: "profile",
    });
  });
});
