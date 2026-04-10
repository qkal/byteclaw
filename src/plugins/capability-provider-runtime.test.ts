import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "./registry.js";

interface MockManifestRegistry {
  plugins: Record<string, unknown>[];
  diagnostics: unknown[];
}

function createEmptyMockManifestRegistry(): MockManifestRegistry {
  return { diagnostics: [], plugins: [] };
}

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn<() => MockManifestRegistry>(() =>
    createEmptyMockManifestRegistry(),
  ),
  resolveRuntimePluginRegistry: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
  withBundledPluginEnablementCompat: vi.fn(({ config }) => config),
  withBundledPluginVitestCompat: vi.fn(({ config }) => config),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

vi.mock("./bundled-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bundled-compat.js")>();
  return {
    ...actual,
    withBundledPluginEnablementCompat: mocks.withBundledPluginEnablementCompat,
    withBundledPluginVitestCompat: mocks.withBundledPluginVitestCompat,
  };
});

let resolvePluginCapabilityProviders: typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders;

function expectResolvedCapabilityProviderIds(providers: { id: string }[], expected: string[]) {
  expect(providers.map((provider) => provider.id)).toEqual(expected);
}

function expectNoResolvedCapabilityProviders(providers: { id: string }[]) {
  expectResolvedCapabilityProviderIds(providers, []);
}

function expectBundledCompatLoadPath(params: {
  cfg: OpenClawConfig;
  allowlistCompat: OpenClawConfig;
  enablementCompat: {
    plugins: {
      allow?: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
    config: params.cfg,
    env: process.env,
  });
  expect(mocks.withBundledPluginEnablementCompat).toHaveBeenCalledWith({
    config: params.allowlistCompat,
    pluginIds: ["openai"],
  });
  expect(mocks.withBundledPluginVitestCompat).toHaveBeenCalledWith({
    config: params.enablementCompat,
    env: process.env,
    pluginIds: ["openai"],
  });
  expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
    config: params.enablementCompat,
  });
}

function createCompatChainConfig() {
  const cfg = { plugins: { allow: ["custom-plugin"] } } as OpenClawConfig;
  const allowlistCompat = {
    plugins: {
      allow: ["custom-plugin", "openai"],
    },
  } as OpenClawConfig;
  const enablementCompat = {
    plugins: {
      allow: ["custom-plugin", "openai"],
      entries: { openai: { enabled: true } },
    },
  };
  return { allowlistCompat, cfg, enablementCompat };
}

function setBundledCapabilityFixture(contractKey: string) {
  mocks.loadPluginManifestRegistry.mockReturnValue({
    diagnostics: [],
    plugins: [
      {
        contracts: { [contractKey]: ["openai"] },
        id: "openai",
        origin: "bundled",
      },
      {
        contracts: {},
        id: "custom-plugin",
        origin: "workspace",
      },
    ] as never,
  });
}

function expectCompatChainApplied(params: {
  key:
    | "memoryEmbeddingProviders"
    | "speechProviders"
    | "realtimeTranscriptionProviders"
    | "realtimeVoiceProviders"
    | "mediaUnderstandingProviders"
    | "imageGenerationProviders"
    | "videoGenerationProviders"
    | "musicGenerationProviders";
  contractKey: string;
  cfg: OpenClawConfig;
  allowlistCompat: OpenClawConfig;
  enablementCompat: {
    plugins: {
      allow?: string[];
      entries: { openai: { enabled: boolean } };
    };
  };
}) {
  setBundledCapabilityFixture(params.contractKey);
  mocks.withBundledPluginEnablementCompat.mockReturnValue(params.enablementCompat);
  mocks.withBundledPluginVitestCompat.mockReturnValue(params.enablementCompat);
  expectNoResolvedCapabilityProviders(
    resolvePluginCapabilityProviders({ cfg: params.cfg, key: params.key }),
  );
  expectBundledCompatLoadPath(params);
}

describe("resolvePluginCapabilityProviders", () => {
  beforeAll(async () => {
    ({ resolvePluginCapabilityProviders } = await import("./capability-provider-runtime.js"));
  });

  beforeEach(() => {
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createEmptyMockManifestRegistry());
    mocks.withBundledPluginEnablementCompat.mockReset();
    mocks.withBundledPluginEnablementCompat.mockImplementation(({ config }) => config);
    mocks.withBundledPluginVitestCompat.mockReset();
    mocks.withBundledPluginVitestCompat.mockImplementation(({ config }) => config);
  });

  it("uses the active registry when capability providers are already loaded", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "openai",
      pluginName: "openai",
      provider: {
        id: "openai",
        isConfigured: () => true,
        label: "openai",
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          fileExtension: ".mp3",
          outputFormat: "mp3",
          voiceCompatible: false,
        }),
      },
      source: "test",
    } as never);
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({ key: "speechProviders" });

    expectResolvedCapabilityProviderIds(providers, ["openai"]);
    expect(mocks.loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
  });

  it("keeps active capability providers even when cfg is passed", () => {
    const active = createEmptyPluginRegistry();
    active.speechProviders.push({
      pluginId: "microsoft",
      pluginName: "microsoft",
      provider: {
        aliases: ["edge"],
        id: "microsoft",
        isConfigured: () => true,
        label: "microsoft",
        synthesize: async () => ({
          audioBuffer: Buffer.from("x"),
          fileExtension: ".mp3",
          outputFormat: "mp3",
          voiceCompatible: false,
        }),
      },
      source: "test",
    } as never);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? active : createEmptyPluginRegistry(),
    );

    const providers = resolvePluginCapabilityProviders({
      cfg: { messages: { tts: { provider: "edge" } } } as OpenClawConfig,
      key: "speechProviders",
    });

    expectResolvedCapabilityProviderIds(providers, ["microsoft"]);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith();
    expect(mocks.resolveRuntimePluginRegistry).not.toHaveBeenCalledWith({
      config: expect.anything(),
    });
  });

  it.each([
    ["memoryEmbeddingProviders", "memoryEmbeddingProviders"],
    ["speechProviders", "speechProviders"],
    ["realtimeTranscriptionProviders", "realtimeTranscriptionProviders"],
    ["realtimeVoiceProviders", "realtimeVoiceProviders"],
    ["mediaUnderstandingProviders", "mediaUnderstandingProviders"],
    ["imageGenerationProviders", "imageGenerationProviders"],
    ["videoGenerationProviders", "videoGenerationProviders"],
    ["musicGenerationProviders", "musicGenerationProviders"],
  ] as const)("applies bundled compat before fallback loading for %s", (key, contractKey) => {
    const { cfg, allowlistCompat, enablementCompat } = createCompatChainConfig();
    expectCompatChainApplied({
      allowlistCompat,
      cfg,
      contractKey,
      enablementCompat,
      key,
    });
  });

  it("reuses a compatible active registry even when the capability list is empty", () => {
    const active = createEmptyPluginRegistry();
    mocks.resolveRuntimePluginRegistry.mockReturnValue(active);

    const providers = resolvePluginCapabilityProviders({
      cfg: {} as OpenClawConfig,
      key: "mediaUnderstandingProviders",
    });

    expectNoResolvedCapabilityProviders(providers);
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: expect.anything(),
    });
  });

  it("loads bundled capability providers even without an explicit cfg", () => {
    const compatConfig = {
      plugins: {
        allow: ["google"],
        enabled: true,
        entries: { google: { enabled: true } },
      },
    } as OpenClawConfig;
    const loaded = createEmptyPluginRegistry();
    loaded.mediaUnderstandingProviders.push({
      pluginId: "google",
      pluginName: "google",
      provider: {
        autoPriority: { audio: 40, image: 30, video: 10 },
        capabilities: ["image", "audio", "video"],
        describeImage: vi.fn(),
        describeVideo: vi.fn(),
        id: "google",
        nativeDocumentInputs: ["pdf"],
        transcribeAudio: vi.fn(),
      },
      source: "test",
    } as never);
    setBundledCapabilityFixture("mediaUnderstandingProviders");
    mocks.withBundledPluginEnablementCompat.mockReturnValue(compatConfig);
    mocks.withBundledPluginVitestCompat.mockReturnValue(compatConfig);
    mocks.resolveRuntimePluginRegistry.mockImplementation((params?: unknown) =>
      params === undefined ? undefined : loaded,
    );

    const providers = resolvePluginCapabilityProviders({ key: "mediaUnderstandingProviders" });

    expectResolvedCapabilityProviderIds(providers, ["google"]);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: undefined,
      env: process.env,
    });
    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith({ config: compatConfig });
  });
});
