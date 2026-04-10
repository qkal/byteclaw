import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { Mock } from "vitest";
import { expect, vi } from "vitest";

export interface NativeCommandSpecMock {
  name: string;
  description: string;
  acceptsArgs: boolean;
}

export interface PluginCommandSpecMock {
  name: string;
  description: string;
  acceptsArgs: boolean;
}

interface ProviderMonitorTestMocks {
  clientHandleDeployRequestMock: Mock<() => Promise<void>>;
  clientFetchUserMock: Mock<(target: string) => Promise<{ id: string }>>;
  clientGetPluginMock: Mock<(name: string) => unknown>;
  clientConstructorOptionsMock: Mock<(options?: unknown) => void>;
  createDiscordAutoPresenceControllerMock: Mock<() => unknown>;
  createDiscordExecApprovalButtonContextMock: Mock<
    (params?: {
      cfg?: OpenClawConfig;
      accountId?: string;
      config?: unknown;
      gatewayUrl?: string;
    }) => { getApprovers: () => string[]; resolveApproval: () => Promise<boolean> }
  >;
  createExecApprovalButtonMock: Mock<(ctx?: unknown) => unknown>;
  createDiscordNativeCommandMock: Mock<(params?: { command?: { name?: string } }) => unknown>;
  createDiscordMessageHandlerMock: Mock<() => unknown>;
  createNoopThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  createThreadBindingManagerMock: Mock<() => { stop: ReturnType<typeof vi.fn> }>;
  reconcileAcpThreadBindingsOnStartupMock: Mock<() => unknown>;
  createdBindingManagers: { stop: ReturnType<typeof vi.fn> }[];
  getAcpSessionStatusMock: Mock<
    (params: {
      cfg: OpenClawConfig;
      sessionKey: string;
      signal?: AbortSignal;
    }) => Promise<{ state: string }>
  >;
  getPluginCommandSpecsMock: Mock<(provider?: string) => PluginCommandSpecMock[]>;
  listNativeCommandSpecsForConfigMock: Mock<
    (
      cfg?: unknown,
      params?: { skillCommands?: unknown[]; provider?: string },
    ) => NativeCommandSpecMock[]
  >;
  listSkillCommandsForAgentsMock: Mock<
    (params?: { cfg?: unknown; agentIds?: string[] }) => unknown[]
  >;
  monitorLifecycleMock: Mock<(params: { threadBindings: { stop: () => void } }) => Promise<void>>;
  resolveDiscordAccountMock: Mock<
    (params?: { cfg?: unknown; accountId?: string | null; token?: string | null }) => unknown
  >;
  resolveDiscordAllowlistConfigMock: Mock<() => Promise<unknown>>;
  resolveNativeCommandsEnabledMock: Mock<(params?: unknown) => boolean>;
  resolveNativeSkillsEnabledMock: Mock<(params?: unknown) => boolean>;
  isVerboseMock: Mock<() => boolean>;
  shouldLogVerboseMock: Mock<() => boolean>;
  voiceRuntimeModuleLoadedMock: Mock<() => void>;
}

export function baseDiscordAccountConfig() {
  return {
    agentComponents: { enabled: false },
    commands: { native: true, nativeSkills: false },
    execApprovals: { enabled: false },
    voice: { enabled: false },
  };
}

const providerMonitorTestMocks: ProviderMonitorTestMocks = vi.hoisted(() => {
  const createdBindingManagers: { stop: ReturnType<typeof vi.fn> }[] = [];
  const isVerboseMock = vi.fn(() => false);
  const shouldLogVerboseMock = vi.fn(() => false);

  return {
    clientConstructorOptionsMock: vi.fn(),
    clientFetchUserMock: vi.fn(async (_target: string) => ({ id: "bot-1" })),
    clientGetPluginMock: vi.fn<(_name: string) => unknown>(() => undefined),
    clientHandleDeployRequestMock: vi.fn(async () => undefined),
    createDiscordAutoPresenceControllerMock: vi.fn(() => ({
      enabled: false,
      refresh: vi.fn(),
      runNow: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createDiscordExecApprovalButtonContextMock: vi.fn(() => ({
      getApprovers: () => [],
      resolveApproval: async () => false,
    })),
    createDiscordMessageHandlerMock: vi.fn(() =>
      Object.assign(
        vi.fn(async () => undefined),
        {
          deactivate: vi.fn(),
        },
      ),
    ),
    createDiscordNativeCommandMock: vi.fn((params?: { command?: { name?: string } }) => ({
      name: params?.command?.name ?? "mock-command",
    })),
    createExecApprovalButtonMock: vi.fn(() => ({ id: "exec-approval" })),
    createNoopThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createThreadBindingManagerMock: vi.fn(() => {
      const manager = { stop: vi.fn() };
      createdBindingManagers.push(manager);
      return manager;
    }),
    createdBindingManagers,
    getAcpSessionStatusMock: vi.fn(
      async (_params: { cfg: OpenClawConfig; sessionKey: string; signal?: AbortSignal }) => ({
        state: "idle",
      }),
    ),
    getPluginCommandSpecsMock: vi.fn<(provider?: string) => PluginCommandSpecMock[]>(() => []),
    isVerboseMock,
    listNativeCommandSpecsForConfigMock: vi.fn<
      (
        cfg?: unknown,
        params?: { skillCommands?: unknown[]; provider?: string },
      ) => NativeCommandSpecMock[]
    >(() => [{ acceptsArgs: false, description: "built-in", name: "cmd" }]),
    listSkillCommandsForAgentsMock: vi.fn<
      (params?: { cfg?: unknown; agentIds?: string[] }) => unknown[]
    >(() => []),
    monitorLifecycleMock: vi.fn(async (params: { threadBindings: { stop: () => void } }) => {
      params.threadBindings.stop();
    }),
    reconcileAcpThreadBindingsOnStartupMock: vi.fn(() => ({
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    })),
    resolveDiscordAccountMock: vi.fn((_) => ({
      accountId: "default",
      config: baseDiscordAccountConfig(),
      token: "cfg-token",
    })),
    resolveDiscordAllowlistConfigMock: vi.fn(async () => ({
      allowFrom: undefined,
      guildEntries: undefined,
    })),
    resolveNativeCommandsEnabledMock: vi.fn((_params) => true),
    resolveNativeSkillsEnabledMock: vi.fn((_params) => false),
    shouldLogVerboseMock,
    voiceRuntimeModuleLoadedMock: vi.fn(),
  };
});

function buildDiscordSourceModuleId(artifactBasename: string): string {
  return `../${artifactBasename}`;
}

const {
  clientHandleDeployRequestMock,
  clientFetchUserMock,
  clientGetPluginMock,
  clientConstructorOptionsMock,
  createDiscordAutoPresenceControllerMock,
  createDiscordExecApprovalButtonContextMock,
  createExecApprovalButtonMock,
  createDiscordNativeCommandMock,
  createDiscordMessageHandlerMock,
  createNoopThreadBindingManagerMock,
  createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartupMock,
  createdBindingManagers,
  getAcpSessionStatusMock,
  getPluginCommandSpecsMock,
  listNativeCommandSpecsForConfigMock,
  listSkillCommandsForAgentsMock,
  monitorLifecycleMock,
  resolveDiscordAccountMock,
  resolveDiscordAllowlistConfigMock,
  resolveNativeCommandsEnabledMock,
  resolveNativeSkillsEnabledMock,
  isVerboseMock,
  shouldLogVerboseMock,
  voiceRuntimeModuleLoadedMock,
} = providerMonitorTestMocks;

export function getProviderMonitorTestMocks(): typeof providerMonitorTestMocks {
  return providerMonitorTestMocks;
}

export function mockResolvedDiscordAccountConfig(overrides: Record<string, unknown>) {
  resolveDiscordAccountMock.mockImplementation(() => ({
    accountId: "default",
    config: {
      ...baseDiscordAccountConfig(),
      ...overrides,
    },
    token: "cfg-token",
  }));
}

export function getFirstDiscordMessageHandlerParams<T extends object>() {
  expect(createDiscordMessageHandlerMock).toHaveBeenCalledTimes(1);
  const firstCall = createDiscordMessageHandlerMock.mock.calls.at(0) as [T] | undefined;
  return firstCall?.[0];
}

export function resetDiscordProviderMonitorMocks(params?: {
  nativeCommands?: NativeCommandSpecMock[];
}) {
  clientHandleDeployRequestMock.mockClear().mockResolvedValue(undefined);
  clientFetchUserMock.mockClear().mockResolvedValue({ id: "bot-1" });
  clientGetPluginMock.mockClear().mockReturnValue(undefined);
  clientConstructorOptionsMock.mockClear();
  createDiscordAutoPresenceControllerMock.mockClear().mockImplementation(() => ({
    enabled: false,
    refresh: vi.fn(),
    runNow: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  createDiscordExecApprovalButtonContextMock.mockClear().mockImplementation(() => ({
    getApprovers: () => [],
    resolveApproval: async () => false,
  }));
  createExecApprovalButtonMock.mockClear().mockImplementation(() => ({ id: "exec-approval" }));
  createDiscordNativeCommandMock.mockClear().mockImplementation((input) => ({
    name: input?.command?.name ?? "mock-command",
  }));
  createDiscordMessageHandlerMock.mockClear().mockImplementation(() =>
    Object.assign(
      vi.fn(async () => undefined),
      {
        deactivate: vi.fn(),
      },
    ),
  );
  createNoopThreadBindingManagerMock.mockClear();
  createThreadBindingManagerMock.mockClear();
  reconcileAcpThreadBindingsOnStartupMock.mockClear().mockReturnValue({
    checked: 0,
    removed: 0,
    staleSessionKeys: [],
  });
  createdBindingManagers.length = 0;
  getAcpSessionStatusMock.mockClear().mockResolvedValue({ state: "idle" });
  getPluginCommandSpecsMock.mockClear().mockReturnValue([]);
  listNativeCommandSpecsForConfigMock
    .mockClear()
    .mockReturnValue(
      params?.nativeCommands ?? [{ acceptsArgs: false, description: "built-in", name: "cmd" }],
    );
  listSkillCommandsForAgentsMock.mockClear().mockReturnValue([]);
  monitorLifecycleMock.mockClear().mockImplementation(async (monitorParams) => {
    monitorParams.threadBindings.stop();
  });
  resolveDiscordAccountMock.mockClear().mockReturnValue({
    accountId: "default",
    config: baseDiscordAccountConfig(),
    token: "cfg-token",
  });
  resolveDiscordAllowlistConfigMock.mockClear().mockResolvedValue({
    allowFrom: undefined,
    guildEntries: undefined,
  });
  resolveNativeCommandsEnabledMock.mockClear().mockReturnValue(true);
  resolveNativeSkillsEnabledMock.mockClear().mockReturnValue(false);
  isVerboseMock.mockClear().mockReturnValue(false);
  shouldLogVerboseMock.mockClear().mockReturnValue(false);
  voiceRuntimeModuleLoadedMock.mockClear();
}

export const baseRuntime = (): RuntimeEnv => ({
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
});

export const baseConfig = (): OpenClawConfig =>
  ({
    channels: {
      discord: {
        accounts: {
          default: {
            token: "MTIz.abc.def",
          },
        },
      },
    },
  }) as OpenClawConfig;

vi.mock("@buape/carbon", async () => {
  const actual = await vi.importActual<typeof import("@buape/carbon")>("@buape/carbon");
  class RateLimitError extends Error {
    status = 429;
    discordCode?: number;
    retryAfter: number;
    scope: string | null;
    bucket: string | null;
    constructor(
      response: Response,
      body: { message: string; retry_after: number; global: boolean },
    ) {
      super(body.message);
      this.retryAfter = body.retry_after;
      this.scope = body.global ? "global" : response.headers.get("X-RateLimit-Scope");
      this.bucket = response.headers.get("X-RateLimit-Bucket");
    }
  }
  class Client {
    listeners: unknown[];
    rest: { put: ReturnType<typeof vi.fn> };
    options: unknown;
    constructor(options: unknown, handlers: { listeners?: unknown[] }) {
      this.options = options;
      this.listeners = handlers.listeners ?? [];
      this.rest = { put: vi.fn(async () => undefined) };
      clientConstructorOptionsMock(options);
    }
    async handleDeployRequest() {
      return await clientHandleDeployRequestMock();
    }
    async fetchUser(target: string) {
      return await clientFetchUserMock(target);
    }
    getPlugin(name: string) {
      return clientGetPluginMock(name);
    }
  }
  return { ...actual, Client, RateLimitError };
});

vi.mock("@buape/carbon/gateway", () => ({
  GatewayCloseCodes: { DisallowedIntents: 4014 },
}));

vi.mock("@buape/carbon/voice", () => ({
  VoicePlugin: class VoicePlugin {},
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  return {
    ...actual,
    getAcpSessionManager: () => ({
      getSessionStatus: getAcpSessionStatusMock,
    }),
    isAcpRuntimeError: (error: unknown): error is { code: string } =>
      error instanceof Error && "code" in error,
  };
});

vi.mock("openclaw/plugin-sdk/command-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/command-auth")>(
    "openclaw/plugin-sdk/command-auth",
  );
  return {
    ...actual,
    listNativeCommandSpecsForConfig: listNativeCommandSpecsForConfigMock,
    listSkillCommandsForAgents: listSkillCommandsForAgentsMock,
  };
});
vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    resolveTextChunkLimit: () => 2000,
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    isNativeCommandsExplicitlyDisabled: () => false,
    loadConfig: () => ({}),
    resolveNativeCommandsEnabled: resolveNativeCommandsEnabledMock,
    resolveNativeSkillsEnabled: resolveNativeSkillsEnabledMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createNonExitingRuntime: () => ({ error: vi.fn(), exit: vi.fn(), log: vi.fn() }),
    createSubsystemLogger: () => {
      const logger = {
        child: vi.fn(() => logger),
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      return logger;
    },
    danger: (value: string) => value,
    isVerbose: isVerboseMock,
    logVerbose: vi.fn(),
    shouldLogVerbose: shouldLogVerboseMock,
    warn: (value: string) => value,
  };
});

vi.mock("openclaw/plugin-sdk/infra-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return {
    ...actual,
    formatErrorMessage: (error: unknown) => String(error),
  };
});

vi.mock(buildDiscordSourceModuleId("accounts.js"), () => ({
  resolveDiscordAccount: resolveDiscordAccountMock,
}));

vi.mock(buildDiscordSourceModuleId("probe.js"), () => ({
  fetchDiscordApplicationId: async () => "app-1",
}));

vi.mock(buildDiscordSourceModuleId("token.js"), () => ({
  normalizeDiscordToken: (value?: string) => value,
}));

vi.mock(buildDiscordSourceModuleId("voice/command.js"), () => ({
  createDiscordVoiceCommand: () => ({ name: "voice-command" }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/agent-components.js"), () => ({
  createAgentComponentButton: () => ({ id: "btn" }),
  createAgentSelectMenu: () => ({ id: "menu" }),
  createDiscordComponentButton: () => ({ id: "btn2" }),
  createDiscordComponentChannelSelect: () => ({ id: "channel" }),
  createDiscordComponentMentionableSelect: () => ({ id: "mentionable" }),
  createDiscordComponentModal: () => ({ id: "modal" }),
  createDiscordComponentRoleSelect: () => ({ id: "role" }),
  createDiscordComponentStringSelect: () => ({ id: "string" }),
  createDiscordComponentUserSelect: () => ({ id: "user" }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/auto-presence.js"), () => ({
  createDiscordAutoPresenceController: createDiscordAutoPresenceControllerMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/commands.js"), () => ({
  resolveDiscordSlashCommandConfig: () => ({ ephemeral: false }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/exec-approvals.js"), () => ({
  createDiscordExecApprovalButtonContext: createDiscordExecApprovalButtonContextMock,
  createExecApprovalButton: createExecApprovalButtonMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/gateway-plugin.js"), () => ({
  createDiscordGatewayPlugin: () => ({ id: "gateway-plugin" }),
}));

vi.mock(buildDiscordSourceModuleId("monitor/listeners.js"), () => ({
  DiscordMessageListener: class DiscordMessageListener {},
  DiscordPresenceListener: class DiscordPresenceListener {},
  DiscordReactionListener: class DiscordReactionListener {},
  DiscordReactionRemoveListener: class DiscordReactionRemoveListener {},
  DiscordThreadUpdateListener: class DiscordThreadUpdateListener {},
  registerDiscordListener: vi.fn(),
}));

vi.mock(buildDiscordSourceModuleId("monitor/message-handler.js"), () => ({
  createDiscordMessageHandler: createDiscordMessageHandlerMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/native-command.js"), () => ({
  createDiscordCommandArgFallbackButton: () => ({ id: "arg-fallback" }),
  createDiscordModelPickerFallbackButton: () => ({ id: "model-fallback-btn" }),
  createDiscordModelPickerFallbackSelect: () => ({ id: "model-fallback-select" }),
  createDiscordNativeCommand: createDiscordNativeCommandMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/presence.js"), () => ({
  resolveDiscordPresenceUpdate: () => undefined,
}));

vi.mock(buildDiscordSourceModuleId("monitor/provider.allowlist.js"), () => ({
  resolveDiscordAllowlistConfig: resolveDiscordAllowlistConfigMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/provider.lifecycle.js"), () => ({
  runDiscordGatewayLifecycle: monitorLifecycleMock,
}));

vi.mock(buildDiscordSourceModuleId("monitor/rest-fetch.js"), () => ({
  resolveDiscordRestFetch: () => async () => {
    throw new Error("offline");
  },
}));

vi.mock(buildDiscordSourceModuleId("monitor/thread-bindings.js"), () => ({
  createNoopThreadBindingManager: createNoopThreadBindingManagerMock,
  createThreadBindingManager: createThreadBindingManagerMock,
  reconcileAcpThreadBindingsOnStartup: reconcileAcpThreadBindingsOnStartupMock,
  resolveThreadBindingIdleTimeoutMs: vi.fn(() => 24 * 60 * 60 * 1000),
}));
