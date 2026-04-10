import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
const resolveGatewayStartupPluginIds = vi.hoisted(() => vi.fn(() => ["discord", "telegram"]));
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }) => ({ autoEnabledReasons: {}, changes: [], config })),
);
const primeConfiguredBindingRegistry = vi.hoisted(() =>
  vi.fn(() => ({ bindingCount: 0, channelCount: 0 })),
);
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveGatewayStartupPluginIds,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

vi.mock("../channels/plugins/binding-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/binding-registry.js")>(
    "../channels/plugins/binding-registry.js",
  );
  return {
    ...actual,
    primeConfiguredBindingRegistry,
  };
});

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

vi.mock("../channels/registry.js", () => ({
  CHANNEL_IDS: [],
  CHAT_CHANNEL_ORDER: [],
  formatChannelPrimerLine: () => "",
  formatChannelSelectionLine: () => "",
  getChatChannelMeta: () => null,
  listChatChannelAliases: () => [],
  listChatChannels: () => [],
  normalizeAnyChannelId: () => null,
  normalizeChannelId: () => null,
  normalizeChatChannelId: () => null,
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  channelSetups: [],
  channels: [],
  cliRegistrars: [],
  commands: [],
  conversationBindingResolvedHandlers: [],
  diagnostics,
  gatewayHandlers: {},
  hooks: [],
  httpRoutes: [],
  imageGenerationProviders: [],
  mediaUnderstandingProviders: [],
  memoryEmbeddingProviders: [],
  musicGenerationProviders: [],
  plugins: [],
  providers: [],
  realtimeTranscriptionProviders: [],
  realtimeVoiceProviders: [],
  services: [],
  speechProviders: [],
  tools: [],
  typedHooks: [],
  videoGenerationProviders: [],
  webFetchProviders: [],
  webSearchProviders: [],
});

type ServerPluginsModule = typeof import("./server-plugins.js");
type ServerPluginBootstrapModule = typeof import("./server-plugin-bootstrap.js");
type PluginRuntimeModule = typeof import("../plugins/runtime/index.js");
type PluginRuntimeRegistryModule = typeof import("../plugins/runtime.js");
type GatewayRequestScopeModule = typeof import("../plugins/runtime/gateway-request-scope.js");
type MethodScopesModule = typeof import("./method-scopes.js");
type RuntimeStateModule = typeof import("../plugins/runtime-state.js");

let serverPluginsModule: ServerPluginsModule;
let serverPluginBootstrapModule: ServerPluginBootstrapModule;
let runtimeModule: PluginRuntimeModule;
let runtimeRegistryModule: PluginRuntimeRegistryModule;
let gatewayRequestScopeModule: GatewayRequestScopeModule;
let methodScopesModule: MethodScopesModule;
let getActivePluginRegistryWorkspaceDirFromState: typeof import("../plugins/runtime-state.js").getActivePluginRegistryWorkspaceDirFromState;

function createTestLog() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

function getLastDispatchedParams(): Record<string, unknown> | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.req?.params as Record<string, unknown> | undefined;
}

function getLastDispatchedClientScopes(): string[] {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  const scopes = call?.client?.connect?.scopes;
  return Array.isArray(scopes) ? scopes : [];
}

async function loadTestModules() {
  serverPluginsModule = await import("./server-plugins.js");
  serverPluginBootstrapModule = await import("./server-plugin-bootstrap.js");
  runtimeModule = await import("../plugins/runtime/index.js");
  runtimeRegistryModule = await import("../plugins/runtime.js");
  gatewayRequestScopeModule = await import("../plugins/runtime/gateway-request-scope.js");
  methodScopesModule = await import("./method-scopes.js");
  const runtimeStateModule: RuntimeStateModule = await import("../plugins/runtime-state.js");
  ({ getActivePluginRegistryWorkspaceDirFromState } = runtimeStateModule);
}

async function createSubagentRuntime(
  _serverPlugins: ServerPluginsModule,
  cfg: Record<string, unknown> = {},
): Promise<PluginRuntime["subagent"]> {
  const log = createTestLog();
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  serverPluginBootstrapModule.loadGatewayStartupPlugins({
    baseMethods: [],
    cfg,
    coreGatewayHandlers: {},
    log,
    workspaceDir: "/tmp",
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
    | undefined;
  if (call?.runtimeOptions?.allowGatewaySubagentBinding !== true) {
    throw new Error("Expected loadGatewayPlugins to opt into gateway subagent binding");
  }
  return runtimeModule.createPluginRuntime({ allowGatewaySubagentBinding: true }).subagent;
}

async function reloadServerPluginsModule(): Promise<ServerPluginsModule> {
  vi.resetModules();
  await loadTestModules();
  return serverPluginsModule;
}

function loadGatewayPluginsForTest(
  overrides: Partial<Parameters<ServerPluginsModule["loadGatewayPlugins"]>[0]> = {},
) {
  const log = createTestLog();
  serverPluginsModule.loadGatewayPlugins({
    baseMethods: [],
    cfg: {},
    coreGatewayHandlers: {},
    log,
    workspaceDir: "/tmp",
    ...overrides,
  });
  return log;
}

function loadGatewayStartupPluginsForTest(
  overrides: Partial<Parameters<ServerPluginBootstrapModule["loadGatewayStartupPlugins"]>[0]> = {},
) {
  const log = createTestLog();
  serverPluginBootstrapModule.loadGatewayStartupPlugins({
    baseMethods: [],
    cfg: {},
    coreGatewayHandlers: {},
    log,
    workspaceDir: "/tmp",
    ...overrides,
  });
  return log;
}

beforeAll(async () => {
  await loadTestModules();
});

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  resolveGatewayStartupPluginIds.mockReset().mockReturnValue(["discord", "telegram"]);
  applyPluginAutoEnable
    .mockReset()
    .mockImplementation(({ config }) => ({ autoEnabledReasons: {}, changes: [], config }));
  primeConfiguredBindingRegistry.mockClear().mockReturnValue({ bindingCount: 0, channelCount: 0 });
  handleGatewayRequest.mockReset();
  runtimeModule.clearGatewaySubagentRuntime();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent": {
        opts.respond(true, { runId: "run-1" });
        return;
      }
      case "agent.wait": {
        opts.respond(true, { status: "ok" });
        return;
      }
      case "sessions.get": {
        opts.respond(true, { messages: [] });
        return;
      }
      case "sessions.delete": {
        opts.respond(true, {});
        return;
      }
      default: {
        opts.respond(true, {});
      }
    }
  });
});

afterEach(() => {
  runtimeModule.clearGatewaySubagentRuntime();
  runtimeRegistryModule.resetPluginRuntimeStateForTest();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        message: "failed to load plugin: boom",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = loadGatewayStartupPluginsForTest();

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("loads only gateway startup plugin ids", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      activationSourceConfig: undefined,
      config: {},
      env: process.env,
      workspaceDir: "/tmp",
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["discord", "telegram"],
      }),
    );
  });

  test("reuses the provided startup plugin scope without recomputing it", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      pluginIds: ["browser"],
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["browser"],
      }),
    );
  });

  test("pins the initial startup channel registry against later active-registry churn", async () => {
    const startupRegistry = createRegistry([]);
    loadOpenClawPlugins.mockReturnValue(startupRegistry);

    loadGatewayStartupPluginsForTest({
      pluginIds: ["slack"],
    });

    const replacementRegistry = createRegistry([]);
    runtimeRegistryModule.setActivePluginRegistry(replacementRegistry);

    expect(runtimeRegistryModule.getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  test("keeps the raw activation source when a precomputed startup scope is reused", async () => {
    const rawConfig = { channels: { slack: { botToken: "x" } } };
    const resolvedConfig = {
      autoEnabled: true,
      channels: { slack: { botToken: "x", enabled: true } },
    };
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
      changes: [],
      config: resolvedConfig,
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayStartupPluginsForTest({
      activationSourceConfig: rawConfig,
      cfg: resolvedConfig,
      pluginIds: ["slack"],
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
        config: resolvedConfig,
        onlyPluginIds: ["slack"],
      }),
    );
  });

  test("treats an empty startup scope as no plugin load instead of an unscoped load", async () => {
    resolveGatewayStartupPluginIds.mockReturnValue([]);

    const result = serverPluginsModule.loadGatewayPlugins({
      baseMethods: ["sessions.get"],
      cfg: {},
      coreGatewayHandlers: {},
      log: createTestLog(),
      workspaceDir: "/tmp",
    });

    expect(loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(result.pluginRegistry.plugins).toEqual([]);
    expect(result.gatewayMethods).toEqual(["sessions.get"]);
  });

  test("stores workspaceDir on the active registry when startup scope is empty", () => {
    resolveGatewayStartupPluginIds.mockReturnValue([]);

    serverPluginsModule.loadGatewayPlugins({
      baseMethods: [],
      cfg: {},
      coreGatewayHandlers: {},
      log: createTestLog(),
      workspaceDir: "/tmp/gateway-workspace",
    });

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/tmp/gateway-workspace");
  });

  test("loads gateway plugins from the auto-enabled config snapshot", async () => {
    const autoEnabledConfig = { autoEnabled: true, channels: { slack: { enabled: true } } };
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest();

    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      activationSourceConfig: undefined,
      config: autoEnabledConfig,
      env: process.env,
      workspaceDir: "/tmp",
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: {},
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
        config: autoEnabledConfig,
      }),
    );
  });

  test("re-derives auto-enable reasons when only activationSourceConfig is provided", async () => {
    const rawConfig = { channels: { slack: { enabled: true } } };
    const resolvedConfig = { autoEnabled: true, channels: { slack: { enabled: true } } };
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
      changes: [],
      config: resolvedConfig,
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      activationSourceConfig: rawConfig,
      cfg: resolvedConfig,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      activationSourceConfig: rawConfig,
      config: resolvedConfig,
      env: process.env,
      workspaceDir: "/tmp",
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
        config: resolvedConfig,
      }),
    );
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
      | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
      | undefined;
    expect(call?.runtimeOptions?.allowGatewaySubagentBinding).toBe(true);
    const { subagent } = runtimeModule.createPluginRuntime({
      allowGatewaySubagentBinding: true,
    });
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("forwards provider and model overrides when the request scope is authorized", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const scope = {
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      context: createTestContext("request-scope-forward-overrides"),
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
      runtime.run({
        deliver: false,
        message: "use the override",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        sessionKey: "s-override",
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      deliver: false,
      message: "use the override",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      sessionKey: "s-override",
    });
  });

  test("rejects provider/model overrides for fallback runs without explicit authorization", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-deny-overrides"));

    await expect(
      runtime.run({
        deliver: false,
        message: "use the override",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        sessionKey: "s-fallback-override",
      }),
    ).rejects.toThrow(
      "provider/model override requires plugin identity in fallback subagent runs.",
    );
  });

  test("allows trusted fallback provider/model overrides when plugin config is explicit", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-trusted-overrides"));
    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        deliver: false,
        message: "use trusted override",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        sessionKey: "s-trusted-override",
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      model: "claude-haiku-4-5",
      provider: "anthropic",
      sessionKey: "s-trusted-override",
    });
  });

  test("includes docs guidance when a plugin fallback override is not trusted", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-untrusted-plugin"));

    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          deliver: false,
          message: "use untrusted override",
          model: "claude-haiku-4-5",
          provider: "anthropic",
          sessionKey: "s-untrusted-override",
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/tools/plugin#runtime-helpers and search for: plugins.entries.<id>.subagent.allowModelOverride',
    );
  });

  test("allows trusted fallback model-only overrides when the model ref is canonical", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-model-only-override"));
    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        deliver: false,
        message: "use trusted model-only override",
        model: "anthropic/claude-haiku-4-5",
        sessionKey: "s-model-only-override",
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      model: "anthropic/claude-haiku-4-5",
      sessionKey: "s-model-only-override",
    });
    expect(getLastDispatchedParams()).not.toHaveProperty("provider");
  });

  test("rejects trusted fallback overrides when the configured allowlist normalizes to empty", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-invalid-allowlist"));
    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          deliver: false,
          message: "use trusted override",
          model: "claude-haiku-4-5",
          provider: "anthropic",
          sessionKey: "s-invalid-allowlist",
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.',
    );
  });

  test("uses least-privilege synthetic fallback scopes without admin", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-least-privilege"));

    await runtime.run({
      deliver: false,
      message: "run synthetic",
      sessionKey: "s-synthetic",
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows fallback session reads with synthetic write scope", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-session-read"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = methodScopesModule.authorizeOperatorScopesForMethod("sessions.get", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, { messages: [{ id: "m-1" }] });
    });

    await expect(
      runtime.getSessionMessages({
        sessionKey: "s-read",
      }),
    ).resolves.toEqual({
      messages: [{ id: "m-1" }],
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("rejects fallback session deletion without minting admin scope", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-delete-session"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      // Re-run the gateway scope check here so the test proves fallback dispatch
      // Does not smuggle admin into the request client.
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = methodScopesModule.authorizeOperatorScopesForMethod("sessions.delete", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, {});
    });

    await expect(
      runtime.deleteSession({
        deleteTranscript: true,
        sessionKey: "s-delete",
      }),
    ).rejects.toThrow("missing scope: operator.admin");

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows session deletion when the request scope already has admin", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const scope = {
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      context: createTestContext("request-scope-delete-session"),
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await expect(
      gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
        runtime.deleteSession({
          deleteTranscript: true,
          sessionKey: "s-delete-admin",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
  });

  test("can prefer setup-runtime channel plugins during startup loads", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest({
      preferSetupRuntimeForChannelPlugins: true,
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        preferSetupRuntimeForChannelPlugins: true,
      }),
    );
  });

  test("primes configured bindings during gateway startup", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    const cfg = {};
    const autoEnabledConfig = { autoEnabled: true, channels: { slack: { enabled: true } } };
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });
    loadGatewayStartupPluginsForTest({ cfg });

    expect(primeConfiguredBindingRegistry).toHaveBeenCalledWith({ cfg: autoEnabledConfig });
  });

  test("uses the auto-enabled config snapshot for gateway bootstrap policies", async () => {
    const serverPlugins = serverPluginsModule;
    const autoEnabledConfig = {
      plugins: {
        entries: {
          demo: {
            subagent: { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
          },
        },
      },
    };
    applyPluginAutoEnable.mockReturnValue({
      autoEnabledReasons: {},
      changes: [],
      config: autoEnabledConfig,
    });
    const runtime = await createSubagentRuntime(serverPlugins, {});
    serverPlugins.setFallbackGatewayContext(createTestContext("auto-enabled-bootstrap-policy"));

    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("demo", () =>
      runtime.run({
        deliver: false,
        message: "use trusted override",
        model: "openai/gpt-5.4",
        sessionKey: "s-auto-enabled-bootstrap-policy",
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      model: "openai/gpt-5.4",
      sessionKey: "s-auto-enabled-bootstrap-policy",
    });
  });

  test("can suppress duplicate diagnostics when reloading full runtime plugins", async () => {
    const { reloadDeferredGatewayPlugins } = serverPluginBootstrapModule;
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        message: "failed to load plugin: boom",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = createTestLog();

    reloadDeferredGatewayPlugins({
      baseMethods: [],
      cfg: {},
      coreGatewayHandlers: {},
      log,
      logDiagnostics: false,
      workspaceDir: "/tmp",
    });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  test("reuses the initial startup plugin scope during deferred reloads", async () => {
    const { reloadDeferredGatewayPlugins } = serverPluginBootstrapModule;
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    reloadDeferredGatewayPlugins({
      baseMethods: [],
      cfg: {},
      coreGatewayHandlers: {},
      log: createTestLog(),
      logDiagnostics: false,
      pluginIds: ["discord"],
      workspaceDir: "/tmp",
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["discord"],
      }),
    );
  });

  test("runs registry hook before priming configured bindings", async () => {
    const { prepareGatewayPluginLoad } = serverPluginBootstrapModule;
    const order: string[] = [];
    const pluginRegistry = createRegistry([]);
    loadOpenClawPlugins.mockReturnValue(pluginRegistry);
    primeConfiguredBindingRegistry.mockImplementation(() => {
      order.push("prime");
      return { bindingCount: 0, channelCount: 0 };
    });

    prepareGatewayPluginLoad({
      baseMethods: [],
      beforePrimeRegistry: (loadedRegistry) => {
        expect(loadedRegistry).toBe(pluginRegistry);
        order.push("hook");
      },
      cfg: {},
      coreGatewayHandlers: {},
      log: {
        ...createTestLog(),
      },
      workspaceDir: "/tmp",
    });

    expect(order).toEqual(["hook", "prime"]);
  });

  test("shares fallback context across module reloads for existing runtimes", async () => {
    const first = serverPluginsModule;
    const runtime = await createSubagentRuntime(first);

    const staleContext = createTestContext("stale");
    first.setFallbackGatewayContext(staleContext);
    await runtime.run({ message: "hello", sessionKey: "s-1" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    const reloaded = await reloadServerPluginsModule();
    const freshContext = createTestContext("fresh");
    reloaded.setFallbackGatewayContext(freshContext);

    await runtime.run({ message: "hello again", sessionKey: "s-1" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    serverPlugins.setFallbackGatewayContext(firstContext);
    await runtime.run({ message: "before restart", sessionKey: "s-2" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    serverPlugins.setFallbackGatewayContext(secondContext);
    await runtime.run({ message: "after restart", sessionKey: "s-2" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    serverPlugins.setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ message: "mutated context", sessionKey: "s-3" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });

  test("resolves fallback context lazily when a resolver is registered", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    let currentContext = createTestContext("before-resolver-update");

    serverPlugins.setFallbackGatewayContextResolver(() => currentContext);
    await runtime.run({ message: "before resolver update", sessionKey: "s-4" });
    expect(getLastDispatchedContext()).toBe(currentContext);

    currentContext = createTestContext("after-resolver-update");
    await runtime.run({ message: "after resolver update", sessionKey: "s-4" });
    expect(getLastDispatchedContext()).toBe(currentContext);
  });

  test("prefers resolver output over an older fallback context snapshot", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const staleContext = createTestContext("stale-snapshot");
    const freshContext = createTestContext("fresh-resolver");

    serverPlugins.setFallbackGatewayContext(staleContext);
    serverPlugins.setFallbackGatewayContextResolver(() => freshContext);

    await runtime.run({ message: "prefer resolver", sessionKey: "s-5" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });
});
