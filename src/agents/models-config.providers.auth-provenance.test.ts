import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

type ProviderRuntimeModule = typeof import("../plugins/provider-runtime.js");

let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let MINIMAX_OAUTH_MARKER: typeof import("./model-auth-markers.js").MINIMAX_OAUTH_MARKER;
let resolveApiKeyFromCredential: typeof import("./models-config.providers.secrets.js").resolveApiKeyFromCredential;
let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;
let mockedResolveProviderSyntheticAuthWithPlugin: ReturnType<
  typeof vi.mocked<ProviderRuntimeModule["resolveProviderSyntheticAuthWithPlugin"]>
>;

async function loadProviderAuthModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  const [providerRuntimeModule, markersModule, secretsModule] = await Promise.all([
    import("../plugins/provider-runtime.js"),
    import("./model-auth-markers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  mockedResolveProviderSyntheticAuthWithPlugin = vi.mocked(
    providerRuntimeModule.resolveProviderSyntheticAuthWithPlugin,
  );
  ({ NON_ENV_SECRETREF_MARKER } = markersModule);
  ({ MINIMAX_OAUTH_MARKER } = markersModule);
  ({ resolveApiKeyFromCredential } = secretsModule);
  ({ createProviderAuthResolver } = secretsModule);
}

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  mockedResolveProviderSyntheticAuthWithPlugin.mockReset().mockReturnValue(undefined);
});

beforeAll(loadProviderAuthModules);

function buildPairedApiKeyProviders(apiKey: string) {
  return {
    paired: { apiKey },
    provider: { apiKey },
  };
}

describe("models-config provider auth provenance", () => {
  it("persists env keyRef and tokenRef auth profiles as env var markers", () => {
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY", "TOGETHER_API_KEY"]);
    delete process.env.VOLCANO_ENGINE_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    try {
      const volcengineApiKey = resolveApiKeyFromCredential({
        keyRef: { id: "VOLCANO_ENGINE_API_KEY", provider: "default", source: "env" },
        provider: "volcengine",
        type: "api_key",
      })?.apiKey;
      const togetherApiKey = resolveApiKeyFromCredential({
        provider: "together",
        tokenRef: { id: "TOGETHER_API_KEY", provider: "default", source: "env" },
        type: "token",
      })?.apiKey;
      const volcengineProviders = buildPairedApiKeyProviders(volcengineApiKey ?? "");

      expect(volcengineProviders.provider.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(volcengineProviders.paired.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(togetherApiKey).toBe("TOGETHER_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for ref-managed profiles even when runtime plaintext is present", () => {
    const byteplusApiKey = resolveApiKeyFromCredential({
      key: "sk-runtime-resolved-byteplus",
      keyRef: { id: "/byteplus/apiKey", provider: "vault", source: "file" },
      provider: "byteplus",
      type: "api_key",
    })?.apiKey;
    const togetherApiKey = resolveApiKeyFromCredential({
      provider: "together",
      token: "tok-runtime-resolved-together",
      tokenRef: { id: "providers/together/token", provider: "vault", source: "exec" },
      type: "token",
    })?.apiKey;
    const byteplusProviders = buildPairedApiKeyProviders(byteplusApiKey ?? "");

    expect(byteplusProviders.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(byteplusProviders.paired.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(togetherApiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("keeps oauth compatibility markers for minimax-portal", () => {
    const providers = {
      "minimax-portal": {
        apiKey: MINIMAX_OAUTH_MARKER,
      },
    };
    expect(providers["minimax-portal"]?.apiKey).toBe(MINIMAX_OAUTH_MARKER);
  });

  it("prefers profile auth over env auth in provider summaries to match runtime resolution", () => {
    const auth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "env-openai-key",
      } as NodeJS.ProcessEnv,
      {
        profiles: {
          "openai:default": {
            keyRef: { id: "OPENAI_PROFILE_KEY", provider: "default", source: "env" },
            provider: "openai",
            type: "api_key",
          },
        },
        version: 1,
      },
    );

    expect(auth("openai")).toEqual({
      apiKey: "OPENAI_PROFILE_KEY",
      discoveryApiKey: undefined,
      mode: "api_key",
      profileId: "openai:default",
      source: "profile",
    });
  });

  it("resolves plugin-owned synthetic auth through the provider hook", () => {
    mockedResolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "xai-plugin-key",
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver(
      {} as NodeJS.ProcessEnv,
      {
        profiles: {},
        version: 1,
      },
      {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key",
                },
              },
            },
          },
        },
      },
    );

    expect(auth("xai")).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: "xai-plugin-key",
      mode: "api_key",
      source: "none",
    });
  });
});
