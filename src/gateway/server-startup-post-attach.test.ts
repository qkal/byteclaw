import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const startPluginServices = vi.fn(async () => null);
  const startGmailWatcherWithLogs = vi.fn(async () => undefined);
  const loadInternalHooks = vi.fn(async () => 0);
  const setInternalHooksEnabled = vi.fn();
  const startGatewayMemoryBackend = vi.fn(async () => undefined);
  const scheduleGatewayUpdateCheck = vi.fn(() => () => {});
  const startGatewayTailscaleExposure = vi.fn(async () => null);
  const logGatewayStartup = vi.fn();
  const scheduleSubagentOrphanRecovery = vi.fn();
  const shouldWakeFromRestartSentinel = vi.fn(() => false);
  const scheduleRestartSentinelWake = vi.fn();
  const reconcilePendingSessionIdentities = vi.fn(async () => ({
    checked: 0,
    failed: 0,
    resolved: 0,
  }));
  return {
    loadInternalHooks,
    logGatewayStartup,
    reconcilePendingSessionIdentities,
    scheduleGatewayUpdateCheck,
    scheduleRestartSentinelWake,
    scheduleSubagentOrphanRecovery,
    setInternalHooksEnabled,
    shouldWakeFromRestartSentinel,
    startGatewayMemoryBackend,
    startGatewayTailscaleExposure,
    startGmailWatcherWithLogs,
    startPluginServices,
  };
});

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: vi.fn(async () => []),
}));

vi.mock("../agents/session-write-lock.js", () => ({
  cleanStaleLockFiles: vi.fn(async () => undefined),
}));

vi.mock("../agents/subagent-registry.js", () => ({
  scheduleSubagentOrphanRecovery: hoisted.scheduleSubagentOrphanRecovery,
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/tmp/openclaw-state"),
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: hoisted.startGmailWatcherWithLogs,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(() => ({})),
  setInternalHooksEnabled: hoisted.setInternalHooksEnabled,
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: hoisted.loadInternalHooks,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: hoisted.startPluginServices,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn(() => ({
    reconcilePendingSessionIdentities: hoisted.reconcilePendingSessionIdentities,
  })),
}));

vi.mock("./server-restart-sentinel.js", () => ({
  scheduleRestartSentinelWake: hoisted.scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel: hoisted.shouldWakeFromRestartSentinel,
}));

vi.mock("./server-startup-memory.js", () => ({
  startGatewayMemoryBackend: hoisted.startGatewayMemoryBackend,
}));

vi.mock("./server-startup-log.js", () => ({
  logGatewayStartup: hoisted.logGatewayStartup,
}));

vi.mock("../infra/update-startup.js", () => ({
  scheduleGatewayUpdateCheck: hoisted.scheduleGatewayUpdateCheck,
}));

vi.mock("./server-tailscale.js", () => ({
  startGatewayTailscaleExposure: hoisted.startGatewayTailscaleExposure,
}));

const { startGatewayPostAttachRuntime } = await import("./server-startup-post-attach.js");

describe("startGatewayPostAttachRuntime", () => {
  beforeEach(() => {
    hoisted.startPluginServices.mockClear();
    hoisted.startGmailWatcherWithLogs.mockClear();
    hoisted.loadInternalHooks.mockClear();
    hoisted.setInternalHooksEnabled.mockClear();
    hoisted.startGatewayMemoryBackend.mockClear();
    hoisted.scheduleGatewayUpdateCheck.mockClear();
    hoisted.startGatewayTailscaleExposure.mockClear();
    hoisted.logGatewayStartup.mockClear();
    hoisted.scheduleSubagentOrphanRecovery.mockClear();
    hoisted.shouldWakeFromRestartSentinel.mockReturnValue(false);
    hoisted.scheduleRestartSentinelWake.mockClear();
    hoisted.reconcilePendingSessionIdentities.mockClear();
  });

  it("re-enables chat.history after post-attach sidecars start", async () => {
    const unavailableGatewayMethods = new Set<string>(["chat.history"]);

    await startGatewayPostAttachRuntime({
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1"],
      broadcast: vi.fn(),
      cfgAtStart: { hooks: { internal: { enabled: false } } } as never,
      controlUiBasePath: "/",
      defaultWorkspaceDir: "/tmp/openclaw-workspace",
      deps: {} as never,
      gatewayPluginConfigAtStart: { hooks: { internal: { enabled: false } } } as never,
      isNixMode: false,
      log: { info: vi.fn(), warn: vi.fn() },
      logChannels: {
        error: vi.fn(),
        info: vi.fn(),
      },
      logHooks: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      logTailscale: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      minimalTestGateway: false,
      pluginCount: 0,
      pluginRegistry: { plugins: [] } as never,
      port: 18_789,
      resetOnExit: false,
      startChannels: vi.fn(async () => undefined),
      tailscaleMode: "off",
      tlsEnabled: false,
      unavailableGatewayMethods,
    });

    expect(unavailableGatewayMethods.has("chat.history")).toBe(false);
    expect(hoisted.startPluginServices).toHaveBeenCalledTimes(1);
    expect(hoisted.setInternalHooksEnabled).toHaveBeenCalledWith(false);
  });
});
