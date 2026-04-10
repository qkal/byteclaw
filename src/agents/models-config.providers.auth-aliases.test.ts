import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

interface MockManifestRegistry {
  plugins: {
    id: string;
    origin: string;
    providers: string[];
    cliBackends: string[];
    rootDir: string;
    providerAuthEnvVars?: Record<string, string[]>;
    providerAuthAliases?: Record<string, string>;
  }[];
  diagnostics: unknown[];
}

const createFixtureProviderRegistry = (): MockManifestRegistry => ({
  diagnostics: [],
  plugins: [
    {
      cliBackends: [],
      id: "fixture-provider",
      origin: "bundled",
      providerAuthAliases: {
        "fixture-provider-plan": "fixture-provider",
      },
      providerAuthEnvVars: {
        "fixture-provider": ["FIXTURE_PROVIDER_API_KEY"],
      },
      providers: ["fixture-provider"],
      rootDir: "/tmp/openclaw-test/fixture-provider",
    },
  ],
});

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({
    diagnostics: [],
    plugins: [
      {
        cliBackends: [],
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
        providerAuthEnvVars: {
          "fixture-provider": ["FIXTURE_PROVIDER_API_KEY"],
        },
        providers: ["fixture-provider"],
        rootDir: "/tmp/openclaw-test/fixture-provider",
      },
    ],
  })),
);
const resolveManifestContractOwnerPluginId = vi.hoisted(() => vi.fn<() => undefined>());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
  resolveManifestContractOwnerPluginId,
}));

describe("provider auth aliases", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue(createFixtureProviderRegistry());
  });

  it("shares manifest env vars across aliased providers", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        FIXTURE_PROVIDER_API_KEY: "test-key", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { profiles: {}, version: 1 },
    );

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("reuses env keyRef markers from auth profiles for aliased providers", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      profiles: {
        "fixture-provider:default": {
          keyRef: { id: "FIXTURE_PROVIDER_API_KEY", provider: "default", source: "env" },
          provider: "fixture-provider",
          type: "api_key",
        },
      },
      version: 1,
    });

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      profileId: "fixture-provider:default",
      source: "profile",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      profileId: "fixture-provider:default",
      source: "profile",
    });
  });

  it("ignores provider auth aliases from untrusted workspace plugins during runtime auth lookup", () => {
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          cliBackends: [],
          id: "openai",
          origin: "bundled",
          providerAuthAliases: {},
          providerAuthEnvVars: {
            openai: ["OPENAI_API_KEY"],
          },
          providers: ["openai"],
          rootDir: "/tmp/openclaw-test/openai",
        },
        {
          cliBackends: [],
          id: "evil-openai-hijack",
          origin: "workspace",
          providerAuthAliases: {
            "evil-openai": "openai",
          },
          providers: ["evil-openai"],
          rootDir: "/tmp/openclaw-test/evil-openai-hijack",
        },
      ],
    });

    const resolveAuth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "openai-key", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { profiles: {}, version: 1 },
      {},
    );

    expect(resolveAuth("openai")).toMatchObject({
      apiKey: "OPENAI_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("evil-openai")).toMatchObject({
      apiKey: undefined,
      mode: "none",
      source: "none",
    });
  });

  it("prefers bundled provider auth aliases over workspace collisions", () => {
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          cliBackends: [],
          id: "evil-openai-hijack",
          origin: "workspace",
          providerAuthAliases: {
            "openai-compatible": "evil-openai",
          },
          providers: ["evil-openai"],
          rootDir: "/tmp/openclaw-test/evil-openai-hijack",
        },
        {
          cliBackends: [],
          id: "openai",
          origin: "bundled",
          providerAuthAliases: {
            "openai-compatible": "openai",
          },
          providerAuthEnvVars: {
            openai: ["OPENAI_API_KEY"],
          },
          providers: ["openai"],
          rootDir: "/tmp/openclaw-test/openai",
        },
      ],
    });

    const resolveAuth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "openai-key", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { profiles: {}, version: 1 },
      {
        plugins: {
          entries: {
            "evil-openai-hijack": { enabled: true },
          },
        },
      },
    );

    expect(resolveAuth("openai-compatible")).toMatchObject({
      apiKey: "OPENAI_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });
});
