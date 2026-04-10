import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { createCompatibilityNotice } from "../plugins/status.test-helpers.js";
import { captureEnv } from "../test-utils/env.js";

let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(() => {
  envSnapshot = captureEnv(["OPENCLAW_PROFILE"]);
  process.env.OPENCLAW_PROFILE = "isolated";
});

afterAll(() => {
  envSnapshot.restore();
});

function createDefaultSessionStoreEntry() {
  return {
    cacheRead: 2000,
    cacheWrite: 1000,
    contextTokens: 10_000,
    inputTokens: 2000,
    model: "pi:opus",
    outputTokens: 3000,
    sessionId: "abc123",
    systemSent: true,
    thinkingLevel: "low",
    totalTokens: 5000,
    updatedAt: Date.now() - 60_000,
    verboseLevel: "on",
  };
}

function createUnknownUsageSessionStore() {
  return {
    "+1000": {
      contextTokens: 10_000,
      inputTokens: 2000,
      model: "pi:opus",
      outputTokens: 3000,
      updatedAt: Date.now() - 60_000,
    },
  };
}

function createChannelIssueCollector(channel: string) {
  return (accounts: Record<string, unknown>[]) =>
    accounts
      .filter((account) => typeof account.lastError === "string" && account.lastError)
      .map((account) => ({
        accountId: typeof account.accountId === "string" ? account.accountId : "default",
        channel,
        message: `Channel error: ${String(account.lastError)}`,
      }));
}

function createErrorChannelPlugin(params: { id: string; label: string; docsPath: string }) {
  return {
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    id: params.id,
    meta: {
      blurb: "mock",
      docsPath: params.docsPath,
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
    },
    status: {
      collectStatusIssues: createChannelIssueCollector(params.id),
    },
  };
}

async function withUnknownUsageStore(run: () => Promise<void>) {
  const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
  mocks.loadSessionStore.mockReturnValue(createUnknownUsageSessionStore());
  try {
    await run();
  } finally {
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  }
}

function getRuntimeLogs() {
  return runtimeLogMock.mock.calls.map((call: unknown[]) => String(call[0]));
}

function getJoinedRuntimeLogs() {
  return getRuntimeLogs().join("\n");
}

async function runStatusAndGetLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  runtimeLogMock.mockClear();
  await statusCommand(args, runtime as never);
  return getRuntimeLogs();
}

async function runStatusAndGetJoinedLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  await runStatusAndGetLogs(args);
  return getJoinedRuntimeLogs();
}

interface ProbeGatewayResult {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: { code: number; reason: string } | null;
  health: unknown;
  status: unknown;
  presence: unknown;
  configSnapshot: unknown;
}

function mockProbeGatewayResult(overrides: Partial<ProbeGatewayResult>) {
  mocks.probeGateway.mockReset();
  mocks.probeGateway.mockResolvedValue({
    ...createDefaultProbeGatewayResult(),
    ...overrides,
  });
}

function createDefaultProbeGatewayResult(): ProbeGatewayResult {
  return {
    close: null,
    configSnapshot: null,
    connectLatencyMs: null,
    error: "timeout",
    health: null,
    ok: false,
    presence: null,
    status: null,
    url: "ws://127.0.0.1:18789",
  };
}

function createDefaultSecurityAuditResult() {
  return {
    findings: [
      {
        checkId: "test.critical",
        detail: "Something is very wrong\nbut on two lines",
        remediation: "Do the thing",
        severity: "critical",
        title: "Test critical finding",
      },
      {
        checkId: "test.warn",
        detail: "Something is maybe wrong",
        severity: "warn",
        title: "Test warning finding",
      },
      {
        checkId: "test.info",
        detail: "FYI only",
        severity: "info",
        title: "Test info finding",
      },
      {
        checkId: "test.info2",
        detail: "More FYI",
        severity: "info",
        title: "Another info finding",
      },
    ],
    summary: { critical: 1, info: 2, warn: 1 },
    ts: 0,
  };
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const prevValue = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (prevValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prevValue;
    }
  }
}

const mocks = vi.hoisted(() => ({
  buildPluginCompatibilityNotices: vi.fn((): PluginCompatibilityNotice[] => []),
  callGateway: vi.fn().mockResolvedValue({}),
  getInspectableTaskAuditSummary: vi.fn().mockReturnValue({
    byCode: {
      delivery_failed: 0,
      inconsistent_timestamps: 0,
      lost: 0,
      missing_cleanup: 0,
      stale_queued: 0,
      stale_running: 0,
    },
    errors: 0,
    total: 0,
    warnings: 0,
  }),
  getInspectableTaskRegistrySummary: vi.fn().mockReturnValue({
    active: 0,
    byRuntime: {
      acp: 0,
      cli: 0,
      cron: 0,
      subagent: 0,
    },
    byStatus: {
      cancelled: 0,
      failed: 0,
      lost: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      timed_out: 0,
    },
    failures: 0,
    terminal: 0,
    total: 0,
  }),
  getWebAuthAgeMs: vi.fn().mockReturnValue(5000),
  hasPotentialConfiguredChannels: vi.fn(() => true),
  listGatewayAgentsBasic: vi.fn().mockReturnValue({
    agents: [{ id: "main", name: "Main" }],
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
  }),
  loadConfig: vi.fn().mockReturnValue({ session: {} }),
  loadNodeHostConfig: vi.fn().mockResolvedValue(null),
  loadSessionStore: vi.fn().mockReturnValue({
    "+1000": createDefaultSessionStoreEntry(),
  }),
  logWebSelfId: vi.fn(),
  probeGateway: vi.fn().mockResolvedValue({
    ...createDefaultProbeGatewayResult(),
  }),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  resolveGatewayService: vi.fn().mockReturnValue({
    install: async () => {},
    isLoaded: async () => true,
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "gateway"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
    }),
    readRuntime: async () => ({ status: "running", pid: 1234 }),
    restart: async () => ({ outcome: "completed" as const }),
    stage: async () => {},
    stop: async () => {},
    uninstall: async () => {},
  }),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  resolveNodeService: vi.fn().mockReturnValue({
    install: async () => {},
    isLoaded: async () => true,
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "node-host"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
    }),
    readRuntime: async () => ({ status: "running", pid: 4321 }),
    restart: async () => ({ outcome: "completed" as const }),
    stage: async () => {},
    stop: async () => {},
    uninstall: async () => {},
  }),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  runSecurityAudit: vi.fn().mockResolvedValue(createDefaultSecurityAuditResult()),
  webAuthExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("../channels/config-presence.js", () => ({
  hasMeaningfulChannelConfig: (entry: unknown) =>
    Boolean(
      entry && typeof entry === "object" && Object.keys(entry as Record<string, unknown>).length,
    ),
  hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
  listPotentialConfiguredChannelIds: (cfg: { channels?: Record<string, unknown> }) =>
    Object.keys(cfg.channels ?? {}).filter((key) => key !== "defaults" && key !== "modelByChannel"),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
    manager: {
      __agentId: agentId,
      close: vi.fn(async () => {}),
      probeVectorAvailability: vi.fn(async () => true),
      status: () => ({
        cache: { enabled: true, entries: 10, maxEntries: 500 },
        chunks: 3,
        dbPath: "/tmp/memory.sqlite",
        dirty: false,
        files: 2,
        fts: { available: true, enabled: true },
        model: "text-embedding-3-small",
        provider: "openai",
        requestedProvider: "openai",
        sourceCounts: [{ source: "memory", files: 2, chunks: 3 }],
        sources: ["memory"],
        vector: {
          available: true,
          dims: 1024,
          enabled: true,
          extensionPath: "/opt/vec0.dylib",
        },
        workspaceDir: "/tmp/openclaw",
      }),
    },
  })),
}));

vi.mock("../config/sessions/main-session.js", () => ({
  resolveMainSessionKey: mocks.resolveMainSessionKey,
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: mocks.resolveStorePath,
}));
vi.mock("../config/sessions/store-read.js", () => ({
  readSessionStoreReadOnly: mocks.loadSessionStore,
}));
vi.mock("../config/sessions/types.js", () => ({
  resolveFreshSessionTotalTokens: vi.fn(
    (entry?: { totalTokens?: number; totalTokensFresh?: boolean }) =>
      typeof entry?.totalTokens === "number" && entry?.totalTokensFresh !== false
        ? entry.totalTokens
        : undefined,
  ),
}));
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) =>
    [
      {
        config: {
          hasPersistentAuth: () => true,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "whatsapp",
        meta: {
          blurb: "mock",
          docsPath: "/platforms/whatsapp",
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
        },
        status: {
          buildChannelSummary: async () => ({ linked: true, authAgeMs: 5000 }),
        },
      },
      {
        ...createErrorChannelPlugin({
          docsPath: "/platforms/signal",
          id: "signal",
          label: "Signal",
        }),
      },
      {
        ...createErrorChannelPlugin({
          docsPath: "/platforms/mac",
          id: "imessage",
          label: "iMessage",
        }),
      },
    ].find((plugin) => plugin.id === channelId) as unknown,
  listChannelPlugins: () => {
    const plugins = [
      {
        config: {
          hasPersistentAuth: () => true,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "whatsapp",
        meta: {
          blurb: "mock",
          docsPath: "/platforms/whatsapp",
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
        },
        status: {
          buildChannelSummary: async () => ({ linked: true, authAgeMs: 5000 }),
        },
      },
      {
        ...createErrorChannelPlugin({
          docsPath: "/platforms/signal",
          id: "signal",
          label: "Signal",
        }),
      },
      {
        ...createErrorChannelPlugin({
          docsPath: "/platforms/mac",
          id: "imessage",
          label: "iMessage",
        }),
      },
    ] as const;
    return plugins as unknown;
  },
}));
vi.mock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
  getWebAuthAgeMs: mocks.getWebAuthAgeMs,
  logWebSelfId: mocks.logWebSelfId,
  readWebSelfId: mocks.readWebSelfId,
  webAuthExists: mocks.webAuthExists,
}));
vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));
vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: vi.fn(() => ({
    message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
  })),
  callGateway: mocks.callGateway,
  resolveGatewayCredentialsWithSecretInputs: vi.fn(
    async (params: {
      config?: {
        gateway?: {
          auth?: {
            token?: unknown;
          };
        };
      };
    }) => {
      const token = params.config?.gateway?.auth?.token;
      if (token && typeof token === "object" && "source" in token) {
        throw new GatewaySecretRefUnavailableError("gateway.auth.token");
      }
      const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
      return envToken ? { token: envToken } : {};
    },
  ),
}));
vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: mocks.listGatewayAgentsBasic,
}));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn().mockResolvedValue("/tmp/openclaw"),
  resolveOpenClawPackageRootSync: vi.fn(() => "/tmp/openclaw"),
}));
vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: () => ({
    arch: "arm64",
    label: "macos 14.0 (arm64)",
    platform: "darwin",
    release: "23.0.0",
  }),
}));
vi.mock("../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn().mockResolvedValue({
    deps: {
      lockfilePath: "/tmp/openclaw/pnpm-lock.yaml",
      manager: "pnpm",
      markerPath: "/tmp/openclaw/node_modules/.modules.yaml",
      status: "ok",
    },
    git: {
      ahead: 0,
      behind: 0,
      branch: "main",
      dirty: false,
      fetchOk: true,
      root: "/tmp/openclaw",
      upstream: "origin/main",
    },
    installKind: "git",
    packageManager: "pnpm",
    registry: { latestVersion: "0.0.0" },
    root: "/tmp/openclaw",
  }),
  compareSemverStrings: vi.fn(() => 0),
  formatGitInstallLabel: vi.fn(() => "main · @ deadbeef"),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readBestEffortConfig: vi.fn(async () => mocks.loadConfig()),
  resolveGatewayPort: vi.fn(() => 18_789),
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));
vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: mocks.resolveNodeService,
}));
vi.mock("../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));
vi.mock("../tasks/task-registry.maintenance.js", () => ({
  getInspectableTaskAuditSummary: mocks.getInspectableTaskAuditSummary,
  getInspectableTaskRegistrySummary: mocks.getInspectableTaskRegistrySummary,
}));
vi.mock("../security/audit.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));
vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
  formatPluginCompatibilityNotice: (notice: PluginCompatibilityNotice) =>
    `${notice.pluginId} ${notice.message}`,
  summarizePluginCompatibility: (warnings: PluginCompatibilityNotice[]) => ({
    noticeCount: warnings.length,
    pluginCount: new Set(warnings.map((warning) => warning.pluginId)).size,
  }),
}));

import { statusCommand } from "./status.js";

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

const runtimeLogMock = runtime.log as Mock<(...args: unknown[]) => void>;

vi.mock("../channels/chat-meta.js", () => {
  const mockChatChannels = [
    "telegram",
    "whatsapp",
    "discord",
    "irc",
    "googlechat",
    "slack",
    "signal",
    "imessage",
    "line",
  ] as const;
  const entries = mockChatChannels.map((id) => ({
    blurb: "mock",
    docsPath: `/channels/${id}`,
    id,
    label: id,
    selectionLabel: id,
  }));
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  return {
    CHAT_CHANNEL_ALIASES: {},
    getChatChannelMeta: (id: (typeof mockChatChannels)[number]) => byId[id],
    listChatChannelAliases: () => [],
    listChatChannels: () => entries,
    normalizeChatChannelId: (raw?: string | null) => {
      const value = raw?.trim().toLowerCase();
      return mockChatChannels.includes(value as (typeof mockChatChannels)[number])
        ? (value as (typeof mockChatChannels)[number])
        : null;
    },
  };
});
vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: vi.fn(async () => {
    const service = mocks.resolveGatewayService();
    const loaded = await service.isLoaded();
    const runtime = await service.readRuntime();
    const command = await service.readCommand();
    return {
      externallyManaged: !command && runtime?.status === "running",
      installed: Boolean(command) || runtime?.status === "running",
      label: service.label,
      loaded,
      loadedText: loaded ? service.loadedText : service.notLoadedText,
      managedByOpenClaw: Boolean(command),
      runtimeShort: runtime?.pid ? `pid ${runtime.pid}` : null,
    };
  }),
  getNodeDaemonStatusSummary: vi.fn(async () => {
    const service = mocks.resolveNodeService();
    const loaded = await service.isLoaded();
    const runtime = await service.readRuntime();
    const command = await service.readCommand();
    return {
      externallyManaged: !command && runtime?.status === "running",
      installed: Boolean(command) || runtime?.status === "running",
      label: service.label,
      loaded,
      loadedText: loaded ? service.loadedText : service.notLoadedText,
      managedByOpenClaw: Boolean(command),
      runtimeShort: runtime?.pid ? `pid ${runtime.pid}` : null,
    };
  }),
}));

describe("statusCommand", () => {
  afterEach(() => {
    mocks.hasPotentialConfiguredChannels.mockReset();
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({ session: {} });
    mocks.loadSessionStore.mockReset();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": createDefaultSessionStoreEntry(),
    });
    mocks.resolveMainSessionKey.mockReset();
    mocks.resolveMainSessionKey.mockReturnValue("agent:main:main");
    mocks.resolveStorePath.mockReset();
    mocks.resolveStorePath.mockReturnValue("/tmp/sessions.json");
    mocks.loadNodeHostConfig.mockReset();
    mocks.loadNodeHostConfig.mockResolvedValue(null);
    mocks.probeGateway.mockReset();
    mocks.probeGateway.mockResolvedValue(createDefaultProbeGatewayResult());
    mocks.callGateway.mockReset();
    mocks.callGateway.mockResolvedValue({});
    mocks.listGatewayAgentsBasic.mockReset();
    mocks.listGatewayAgentsBasic.mockReturnValue({
      agents: [{ id: "main", name: "Main" }],
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
    });
    mocks.buildPluginCompatibilityNotices.mockReset();
    mocks.buildPluginCompatibilityNotices.mockReturnValue([]);
    mocks.getInspectableTaskRegistrySummary.mockReset();
    mocks.getInspectableTaskRegistrySummary.mockReturnValue({
      active: 0,
      byRuntime: {
        acp: 0,
        cli: 0,
        cron: 0,
        subagent: 0,
      },
      byStatus: {
        cancelled: 0,
        failed: 0,
        lost: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
        timed_out: 0,
      },
      failures: 0,
      terminal: 0,
      total: 0,
    });
    mocks.getInspectableTaskAuditSummary.mockReset();
    mocks.getInspectableTaskAuditSummary.mockReturnValue({
      byCode: {
        delivery_failed: 0,
        inconsistent_timestamps: 0,
        lost: 0,
        missing_cleanup: 0,
        stale_queued: 0,
        stale_running: 0,
      },
      errors: 0,
      total: 0,
      warnings: 0,
    });
    mocks.hasPotentialConfiguredChannels.mockReset();
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.runSecurityAudit.mockReset();
    mocks.runSecurityAudit.mockResolvedValue(createDefaultSecurityAuditResult());
    mocks.resolveGatewayService.mockReset();
    mocks.resolveGatewayService.mockReturnValue({
      install: async () => {},
      isLoaded: async () => true,
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      readCommand: async () => ({
        programArguments: ["node", "dist/entry.js", "gateway"],
        sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
      }),
      readRuntime: async () => ({ pid: 1234, status: "running" }),
      restart: async () => ({ outcome: "completed" as const }),
      stage: async () => {},
      stop: async () => {},
      uninstall: async () => {},
    });
    mocks.resolveNodeService.mockReset();
    mocks.resolveNodeService.mockReturnValue({
      install: async () => {},
      isLoaded: async () => true,
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      readCommand: async () => ({
        programArguments: ["node", "dist/entry.js", "node-host"],
        sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
      }),
      readRuntime: async () => ({ pid: 4321, status: "running" }),
      restart: async () => ({ outcome: "completed" as const }),
      stage: async () => {},
      stop: async () => {},
      uninstall: async () => {},
    });
    runtimeLogMock.mockClear();
    (runtime.error as Mock<(...args: unknown[]) => void>).mockClear();
  });

  it("prints JSON when requested", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(false);
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      createCompatibilityNotice({ code: "legacy-before-agent-start", pluginId: "legacy-plugin" }),
    ]);
    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls[0]?.[0]));
    expect(payload.linkChannel).toBeUndefined();
    expect(payload.memory).toBeNull();
    expect(payload.memoryPlugin.enabled).toBe(true);
    expect(payload.memoryPlugin.slot).toBe("memory-core");
    expect(payload.sessions.count).toBe(1);
    expect(payload.sessions.paths).toContain("/tmp/sessions.json");
    expect(payload.sessions.defaults.model).toBeTruthy();
    expect(payload.sessions.defaults.contextTokens).toBeGreaterThan(0);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].cacheRead).toBe(2000);
    expect(payload.sessions.recent[0].cacheWrite).toBe(1000);
    expect(payload.sessions.recent[0].totalTokensFresh).toBe(true);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
    expect(payload.sessions.recent[0].flags).toContain("verbose:on");
    expect(payload.securityAudit).toBeUndefined();
    expect(payload.gatewayService.label).toBe("LaunchAgent");
    expect(payload.nodeService.label).toBe("LaunchAgent");
    expect(payload.pluginCompatibility).toEqual({
      count: 0,
      warnings: [],
    });
    expect(payload.tasks).toEqual(
      expect.objectContaining({
        active: 0,
        byStatus: expect.objectContaining({ queued: 0, running: 0 }),
        total: 0,
      }),
    );
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
  });

  it("includes security audit in JSON when all is requested", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(false);

    await statusCommand({ all: true, json: true }, runtime as never);

    const payload = JSON.parse(String(runtimeLogMock.mock.calls[0]?.[0]));
    expect(payload.securityAudit.summary.critical).toBe(1);
    expect(payload.securityAudit.summary.warn).toBe(1);
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        includeChannelSecurity: true,
        includeFilesystem: true,
      }),
    );
  });

  it("surfaces unknown usage when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      runtimeLogMock.mockClear();
      await statusCommand({ json: true }, runtime as never);
      const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
      expect(payload.sessions.recent[0].totalTokens).toBeNull();
      expect(payload.sessions.recent[0].totalTokensFresh).toBe(false);
      expect(payload.sessions.recent[0].percentUsed).toBeNull();
      expect(payload.sessions.recent[0].remainingTokens).toBeNull();
    });
  });

  it("prints unknown usage in formatted output when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("unknown/") && line.includes("(?%)"))).toBe(true);
    });
  });

  it("prints formatted lines otherwise", async () => {
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      createCompatibilityNotice({ code: "legacy-before-agent-start", pluginId: "legacy-plugin" }),
    ]);
    const logs = await runStatusAndGetLogs();
    for (const token of [
      "OpenClaw status",
      "Overview",
      "Security audit",
      "Summary:",
      "CRITICAL",
      "Dashboard",
      "macos 14.0 (arm64)",
      "Memory",
      "Plugin compatibility",
      "Channels",
      "WhatsApp",
      "bootstrap files",
      "Tasks",
      "Sessions",
      "+1000",
      "50%",
      "40% cached",
      "LaunchAgent",
      "FAQ:",
      "Troubleshooting:",
      "Next steps:",
    ]) {
      expect(logs.some((line) => line.includes(token))).toBe(true);
    }
    expect(
      logs.some((line) => line.includes("legacy-plugin still uses legacy before_agent_start")),
    ).toBe(true);
    expect(
      logs.some(
        (line) =>
          line.includes("openclaw status --all") ||
          line.includes("openclaw --profile isolated status --all"),
      ),
    ).toBe(true);
  });

  it("shows explicit cache details in verbose session output", async () => {
    const logs = await runStatusAndGetLogs({ verbose: true });
    expect(logs.some((line) => line.includes("Cache"))).toBe(true);
    expect(logs.some((line) => line.includes("40% hit"))).toBe(true);
    expect(logs.some((line) => line.includes("read 2.0k"))).toBe(true);
  });

  it("shows a maintenance hint when task audit errors are present", async () => {
    mocks.getInspectableTaskRegistrySummary.mockReturnValue({
      active: 1,
      byRuntime: {
        acp: 1,
        cli: 0,
        cron: 0,
        subagent: 0,
      },
      byStatus: {
        cancelled: 0,
        failed: 0,
        lost: 0,
        queued: 0,
        running: 1,
        succeeded: 0,
        timed_out: 0,
      },
      failures: 1,
      terminal: 0,
      total: 1,
    });
    mocks.getInspectableTaskAuditSummary.mockReturnValue({
      byCode: {
        delivery_failed: 0,
        inconsistent_timestamps: 0,
        lost: 0,
        missing_cleanup: 0,
        stale_queued: 0,
        stale_running: 1,
      },
      errors: 1,
      total: 1,
      warnings: 0,
    });

    const joined = await runStatusAndGetJoinedLogs();

    expect(joined).toContain("tasks maintenance --apply");
  });

  it("caps cached percentage at the prompt-token denominator for legacy session totals", async () => {
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        ...createDefaultSessionStoreEntry(),
        cacheRead: 1200,
        cacheWrite: 0,
        inputTokens: undefined,
        totalTokens: 1000,
      },
    });
    try {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("100% cached"))).toBe(true);
      expect(logs.some((line) => line.includes("120% cached"))).toBe(false);
    } finally {
      if (originalLoadSessionStore) {
        mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
      }
    }
  });

  it("uses prompt-side tokens for cached percentage when they differ from totalTokens", async () => {
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        ...createDefaultSessionStoreEntry(),
        cacheRead: 2000,
        cacheWrite: 500,
        inputTokens: 500,
        totalTokens: 5000,
      },
    });
    try {
      const logs = await runStatusAndGetLogs();
      expect(logs.some((line) => line.includes("67% cached"))).toBe(true);
      expect(logs.some((line) => line.includes("40% cached"))).toBe(false);
    } finally {
      if (originalLoadSessionStore) {
        mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
      }
    }
  });

  it("shows node-only gateway info when no local gateway service is installed", async () => {
    mocks.resolveGatewayService.mockReturnValueOnce({
      install: async () => {},
      isLoaded: async () => false,
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      readCommand: async () => null,
      readRuntime: async () => undefined,
      restart: async () => ({ outcome: "completed" as const }),
      stage: async () => {},
      stop: async () => {},
      uninstall: async () => {},
    });
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      gateway: { host: "gateway.example.com", port: 19_000 },
      nodeId: "node-1",
      version: 1,
    });

    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("node → gateway.example.com:19000 · no local gateway");
    expect(joined).not.toContain("Gateway: local · ws://127.0.0.1:18789");
    expect(joined).toContain("openclaw --profile isolated node status");
    expect(joined).not.toContain("Fix reachability first");
  });

  it("shows gateway auth when reachable", async () => {
    mocks.loadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: {},
    });
    await withEnvVar("OPENCLAW_GATEWAY_TOKEN", "abcd1234", async () => {
      mockProbeGatewayResult({
        connectLatencyMs: 123,
        error: null,
        health: {},
        ok: true,
        presence: [],
        status: {},
      });
      const logs = await runStatusAndGetLogs();
      expect(logs.some((l: string) => l.includes("auth token"))).toBe(true);
    });
  });

  it("warns instead of crashing when gateway auth SecretRef is unresolved for probe auth", async () => {
    mocks.loadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      session: {},
    });

    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.gateway.error ?? payload.gateway.authWarning ?? null).not.toBeNull();
    if (Array.isArray(payload.secretDiagnostics) && payload.secretDiagnostics.length > 0) {
      expect(
        payload.secretDiagnostics.some((entry: string) => entry.includes("gateway.auth.token")),
      ).toBe(true);
    }
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("surfaces channel runtime errors from the gateway", async () => {
    mocks.loadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: {},
    });
    mockProbeGatewayResult({
      connectLatencyMs: 10,
      error: null,
      health: {},
      ok: true,
      presence: [],
      status: {},
    });
    mocks.callGateway.mockResolvedValueOnce({
      channelAccounts: {
        imessage: [
          {
            accountId: "default",
            configured: true,
            enabled: true,
            lastError: "imessage permission denied",
            running: false,
          },
        ],
        signal: [
          {
            accountId: "default",
            configured: true,
            enabled: true,
            lastError: "signal-cli unreachable",
            running: false,
          },
        ],
      },
    });

    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toMatch(/Signal/i);
    expect(joined).toMatch(/iMessage/i);
    expect(joined).toMatch(/gateway:/i);
    expect(joined).toMatch(/WARN/);
  });

  it.each([
    {
      closeReason: "pairing required (requestId: req-123)",
      error: "connect failed: pairing required (requestId: req-123)",
      excludes: [],
      includes: ["devices approve req-123"],
      name: "prints requestId-aware recovery guidance when gateway pairing is required",
    },
    {
      closeReason: "connect failed",
      error: "connect failed: pairing required",
      excludes: ["devices approve req-"],
      includes: [],
      name: "prints fallback recovery guidance when pairing requestId is unavailable",
    },
    {
      closeReason: "pairing required (requestId: req-123;rm -rf /)",
      error: "connect failed: pairing required (requestId: req-123;rm -rf /)",
      excludes: ["devices approve req-123;rm -rf /"],
      includes: [],
      name: "does not render unsafe requestId content into approval command hints",
    },
  ])("$name", async ({ error, closeReason, includes, excludes }) => {
    mocks.loadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: {},
    });
    mockProbeGatewayResult({
      close: { code: 1008, reason: closeReason },
      error,
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("Gateway pairing approval required.");
    expect(joined).toContain("devices approve --latest");
    expect(joined).toContain("devices list");
    for (const expected of includes) {
      expect(joined).toContain(expected);
    }
    for (const blocked of excludes) {
      expect(joined).not.toContain(blocked);
    }
  });

  it("extracts requestId from close reason when error text omits it", async () => {
    mocks.loadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: {},
    });
    mockProbeGatewayResult({
      close: { code: 1008, reason: "pairing required (requestId: req-close-456)" },
      error: "connect failed: pairing required",
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("devices approve req-close-456");
  });

  it("includes sessions across agents in JSON output", async () => {
    const originalAgents = mocks.listGatewayAgentsBasic.getMockImplementation();
    const originalResolveStorePath = mocks.resolveStorePath.getMockImplementation();
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();

    mocks.listGatewayAgentsBasic.mockReturnValue({
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
    });
    mocks.resolveStorePath.mockImplementation((_store, opts) =>
      opts?.agentId === "ops" ? "/tmp/ops.json" : "/tmp/main.json",
    );
    mocks.loadSessionStore.mockImplementation((storePath) => {
      if (storePath === "/tmp/ops.json") {
        return {
          "agent:ops:main": {
            contextTokens: 10_000,
            inputTokens: 1000,
            model: "pi:opus",
            outputTokens: 1000,
            totalTokens: 2000,
            updatedAt: Date.now() - 120_000,
          },
        };
      }
      return {
        "+1000": createDefaultSessionStoreEntry(),
      };
    });

    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.sessions.count).toBe(2);
    expect(payload.sessions.paths.length).toBe(2);
    expect(
      payload.sessions.recent.some((sess: { key?: string }) => sess.key === "agent:ops:main"),
    ).toBe(true);

    if (originalAgents) {
      mocks.listGatewayAgentsBasic.mockImplementation(originalAgents);
    }
    if (originalResolveStorePath) {
      mocks.resolveStorePath.mockImplementation(originalResolveStorePath);
    }
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  });
});
