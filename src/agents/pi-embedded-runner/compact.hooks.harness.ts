import { type Mock, vi } from "vitest";

interface MockResolvedModel {
  model: { provider: string; api: string; id: string; input: unknown[] };
  error: null;
  authStorage: { setRuntimeApiKey: Mock<(provider?: string, apiKey?: string) => void> };
  modelRegistry: Record<string, never>;
}
interface MockMemorySearchManager {
  manager: {
    sync: (params?: unknown) => Promise<void>;
  };
}
type MockEmbeddedAgentStreamFn = Mock<
  (model?: unknown, context?: unknown, options?: unknown) => unknown
>;

export const contextEngineCompactMock = vi.fn(async () => ({
  compacted: true as boolean,
  ok: true as boolean,
  reason: undefined as string | undefined,
  result: { summary: "engine-summary", tokensAfter: 50 } as
    | { summary: string; tokensAfter: number }
    | undefined,
}));

export const hookRunner = {
  hasHooks: vi.fn<(hookName?: string) => boolean>(),
  runAfterCompaction: vi.fn(async () => undefined),
  runBeforeCompaction: vi.fn(async () => undefined),
};

export const ensureRuntimePluginsLoaded: Mock<(params?: unknown) => void> = vi.fn();
export const resolveContextEngineMock = vi.fn(async () => ({
  compact: contextEngineCompactMock,
  info: { ownsCompaction: true as boolean },
}));
export const resolveModelMock: Mock<
  (provider?: string, modelId?: string, agentDir?: string, cfg?: unknown) => MockResolvedModel
> = vi.fn((_provider?: string, _modelId?: string, _agentDir?: string, _cfg?: unknown) => ({
  authStorage: { setRuntimeApiKey: vi.fn() },
  error: null,
  model: { api: "responses", id: "fake", input: [], provider: "openai" },
  modelRegistry: {},
}));
export const sessionCompactImpl = vi.fn(async () => ({
  details: { ok: true },
  firstKeptEntryId: "entry-1",
  summary: "summary",
  tokensBefore: 120,
}));
export const triggerInternalHook: Mock<(event?: unknown) => void> = vi.fn();
export const sanitizeSessionHistoryMock = vi.fn(
  async (params: { messages: unknown[] }) => params.messages,
);
export const getMemorySearchManagerMock: Mock<
  (params?: unknown) => Promise<MockMemorySearchManager>
> = vi.fn(async () => ({
  manager: {
    sync: vi.fn(async (_params?: unknown) => {}),
  },
}));
export const resolveMemorySearchConfigMock = vi.fn(() => ({
  sources: ["sessions"],
  sync: {
    sessions: {
      postCompactionForce: true,
    },
  },
}));
export const resolveSessionAgentIdMock = vi.fn(() => "main");
export const estimateTokensMock = vi.fn((_message?: unknown) => 10);
export const sessionMessages: unknown[] = [
  { content: "hello", role: "user", timestamp: 1 },
  { content: [{ text: "hi", type: "text" }], role: "assistant", timestamp: 2 },
  {
    content: [{ text: "output", type: "text" }],
    isError: false,
    role: "toolResult",
    timestamp: 3,
    toolCallId: "t1",
    toolName: "exec",
  },
];
export const sessionAbortCompactionMock: Mock<(reason?: unknown) => void> = vi.fn();
export const createOpenClawCodingToolsMock = vi.fn(() => []);
export const resolveEmbeddedAgentStreamFnMock: Mock<
  (params?: unknown) => MockEmbeddedAgentStreamFn
> = vi.fn((_params?: unknown) => vi.fn());
export const registerProviderStreamForModelMock: Mock<(params?: unknown) => unknown> = vi.fn();
export const applyExtraParamsToAgentMock = vi.fn(() => ({ effectiveExtraParams: {} }));
export const resolveAgentTransportOverrideMock: Mock<(params?: unknown) => string | undefined> =
  vi.fn(() => undefined);

export function resetCompactSessionStateMocks(): void {
  sanitizeSessionHistoryMock.mockReset();
  sanitizeSessionHistoryMock.mockImplementation(
    async (params: { messages: unknown[] }) => params.messages,
  );

  getMemorySearchManagerMock.mockReset();
  getMemorySearchManagerMock.mockResolvedValue({
    manager: {
      sync: vi.fn(async () => {}),
    },
  });
  resolveMemorySearchConfigMock.mockReset();
  resolveMemorySearchConfigMock.mockReturnValue({
    sources: ["sessions"],
    sync: {
      sessions: {
        postCompactionForce: true,
      },
    },
  });
  resolveSessionAgentIdMock.mockReset();
  resolveSessionAgentIdMock.mockReturnValue("main");
  estimateTokensMock.mockReset();
  estimateTokensMock.mockReturnValue(10);
  sessionMessages.splice(
    0,
    sessionMessages.length,
    { content: "hello", role: "user", timestamp: 1 },
    { content: [{ text: "hi", type: "text" }], role: "assistant", timestamp: 2 },
    {
      content: [{ text: "output", type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: 3,
      toolCallId: "t1",
      toolName: "exec",
    },
  );
  sessionAbortCompactionMock.mockReset();
  resolveEmbeddedAgentStreamFnMock.mockReset();
  resolveEmbeddedAgentStreamFnMock.mockImplementation((_params?: unknown) => vi.fn());
  registerProviderStreamForModelMock.mockReset();
  registerProviderStreamForModelMock.mockReturnValue(undefined);
  applyExtraParamsToAgentMock.mockReset();
  applyExtraParamsToAgentMock.mockReturnValue({ effectiveExtraParams: {} });
  resolveAgentTransportOverrideMock.mockReset();
  resolveAgentTransportOverrideMock.mockReturnValue(undefined);
}

export function resetCompactHooksHarnessMocks(): void {
  hookRunner.hasHooks.mockReset();
  hookRunner.hasHooks.mockReturnValue(false);
  hookRunner.runBeforeCompaction.mockReset();
  hookRunner.runBeforeCompaction.mockResolvedValue(undefined);
  hookRunner.runAfterCompaction.mockReset();
  hookRunner.runAfterCompaction.mockResolvedValue(undefined);

  ensureRuntimePluginsLoaded.mockReset();

  resolveContextEngineMock.mockReset();
  resolveContextEngineMock.mockResolvedValue({
    compact: contextEngineCompactMock,
    info: { ownsCompaction: true },
  });
  contextEngineCompactMock.mockReset();
  contextEngineCompactMock.mockResolvedValue({
    compacted: true,
    ok: true,
    reason: undefined,
    result: { summary: "engine-summary", tokensAfter: 50 },
  });

  resolveModelMock.mockReset();
  resolveModelMock.mockReturnValue({
    authStorage: { setRuntimeApiKey: vi.fn() },
    error: null,
    model: { api: "responses", id: "fake", input: [], provider: "openai" },
    modelRegistry: {},
  });

  sessionCompactImpl.mockReset();
  sessionCompactImpl.mockResolvedValue({
    details: { ok: true },
    firstKeptEntryId: "entry-1",
    summary: "summary",
    tokensBefore: 120,
  });

  triggerInternalHook.mockReset();
  resetCompactSessionStateMocks();
  createOpenClawCodingToolsMock.mockReset();
  createOpenClawCodingToolsMock.mockReturnValue([]);
}

export async function loadCompactHooksHarness(): Promise<{
  compactEmbeddedPiSessionDirect: typeof import("./compact.js").compactEmbeddedPiSessionDirect;
  compactEmbeddedPiSession: typeof import("./compact.js").compactEmbeddedPiSession;
  __testing: typeof import("./compact.js").__testing;
  onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
}> {
  resetCompactHooksHarnessMocks();
  vi.resetModules();

  vi.doMock("../../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => hookRunner,
  }));

  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded,
  }));

  vi.doMock("../provider-stream.js", () => ({
    registerProviderStreamForModel: registerProviderStreamForModelMock,
  }));

  vi.doMock("../../hooks/internal-hooks.js", async () => {
    const actual = await vi.importActual<typeof import("../../hooks/internal-hooks.js")>(
      "../../hooks/internal-hooks.js",
    );
    return {
      ...actual,
      triggerInternalHook,
    };
  });

  vi.doMock("@mariozechner/pi-ai/oauth", async () => {
    const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
      "@mariozechner/pi-ai/oauth",
    );
    return {
      ...actual,
      getOAuthApiKey: vi.fn(),
      getOAuthProviders: vi.fn(() => []),
    };
  });

  vi.doMock("@mariozechner/pi-coding-agent", () => ({
    AuthStorage: class AuthStorage {},
    DefaultResourceLoader: class DefaultResourceLoader {},
    ModelRegistry: class ModelRegistry {},
    SessionManager: {
      open: vi.fn(() => ({})),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
    createAgentSession: vi.fn(async () => {
      const session = {
        abortCompaction: sessionAbortCompactionMock,
        agent: {
          state: {
            get messages() {
              return session.messages;
            },
            set messages(messages: unknown[]) {
              session.messages = [...(messages as typeof session.messages)];
            },
          },
          streamFn: vi.fn(),
          transport: "sse",
        },
        compact: vi.fn(async () => {
          session.messages.splice(1);
          return await sessionCompactImpl();
        }),
        dispose: vi.fn(),
        messages: sessionMessages.map((message) =>
          typeof structuredClone === "function"
            ? structuredClone(message)
            : JSON.parse(JSON.stringify(message)),
        ),
        sessionId: "session-1",
      };
      return { session };
    }),
    estimateTokens: estimateTokensMock,
  }));

  vi.doMock("../session-tool-result-guard-wrapper.js", () => ({
    guardSessionManager: vi.fn(() => ({
      flushPendingToolResults: vi.fn(),
    })),
  }));

  vi.doMock("../pi-settings.js", () => ({
    ensurePiCompactionReserveTokens: vi.fn(),
    resolveCompactionReserveTokensFloor: vi.fn(() => 0),
  }));

  vi.doMock("../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));

  vi.doMock("../model-auth.js", () => ({
    applyAuthHeaderOverride: vi.fn((model: unknown) => model),
    applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
    getApiKeyForModel: vi.fn(async () => ({ apiKey: "test", mode: "env" })),
    resolveModelAuthMode: vi.fn(() => "env"),
  }));

  vi.doMock("../sandbox.js", () => ({
    resolveSandboxContext: vi.fn(async () => null),
  }));

  vi.doMock("../session-file-repair.js", () => ({
    repairSessionFileIfNeeded: vi.fn(async () => {}),
  }));

  vi.doMock("../session-write-lock.js", () => ({
    acquireSessionWriteLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 0),
  }));

  vi.doMock("../../context-engine/index.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
    resolveContextEngine: resolveContextEngineMock,
  }));

  vi.doMock("../../process/command-queue.js", () => ({
    clearCommandLane: vi.fn(() => 0),
    enqueueCommandInLane: vi.fn((_lane: unknown, task: () => unknown) => task()),
  }));

  vi.doMock("./lanes.js", () => ({
    resolveGlobalLane: vi.fn(() => "test-global-lane"),
    resolveSessionLane: vi.fn(() => "test-session-lane"),
  }));

  vi.doMock("../context-window-guard.js", () => ({
    resolveContextWindowInfo: vi.fn(() => ({ tokens: 128_000 })),
  }));

  vi.doMock("../bootstrap-files.js", () => ({
    makeBootstrapWarn: vi.fn(() => () => {}),
    resolveBootstrapContextForRun: vi.fn(async () => ({ contextFiles: [] })),
  }));

  vi.doMock("../pi-bundle-mcp-tools.js", () => ({
    createBundleMcpToolRuntime: vi.fn(async () => ({
      dispose: vi.fn(async () => {}),
      tools: [],
    })),
  }));

  vi.doMock("../pi-bundle-lsp-runtime.js", () => ({
    createBundleLspToolRuntime: vi.fn(async () => ({
      dispose: vi.fn(async () => {}),
      sessions: [],
      tools: [],
    })),
  }));

  vi.doMock("../docs-path.js", () => ({
    resolveOpenClawDocsPath: vi.fn(async () => undefined),
  }));

  vi.doMock("../channel-tools.js", () => ({
    listChannelSupportedActions: vi.fn(() => undefined),
    resolveChannelMessageToolHints: vi.fn(() => undefined),
  }));

  vi.doMock("../pi-tools.js", () => ({
    createOpenClawCodingTools: createOpenClawCodingToolsMock,
  }));

  vi.doMock("./replay-history.js", () => ({
    sanitizeSessionHistory: sanitizeSessionHistoryMock,
    validateReplayTurns: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
  }));

  vi.doMock("./tool-schema-runtime.js", () => ({
    logProviderToolSchemaDiagnostics: vi.fn(),
    normalizeProviderToolSchemas: vi.fn(({ tools }: { tools: unknown[] }) => tools),
  }));

  vi.doMock("./stream-resolution.js", () => ({
    resolveEmbeddedAgentApiKey: vi.fn(async () => "test-api-key"),
    resolveEmbeddedAgentBaseStreamFn: vi.fn(() => vi.fn()),
    resolveEmbeddedAgentStreamFn: resolveEmbeddedAgentStreamFnMock,
  }));

  vi.doMock("./extra-params.js", () => ({
    applyExtraParamsToAgent: applyExtraParamsToAgentMock,
    resolveAgentTransportOverride: resolveAgentTransportOverrideMock,
  }));

  vi.doMock("./tool-split.js", () => ({
    splitSdkTools: vi.fn(() => ({ builtInTools: [], customTools: [] })),
  }));

  vi.doMock("./compaction-safety-timeout.js", () => ({
    compactWithSafetyTimeout: vi.fn(
      async (
        compact: () => Promise<unknown>,
        _timeoutMs?: number,
        opts?: { abortSignal?: AbortSignal; onCancel?: () => void },
      ) => {
        const abortSignal = opts?.abortSignal;
        if (!abortSignal) {
          return await compact();
        }
        const cancelAndCreateError = () => {
          opts?.onCancel?.();
          const reason = "reason" in abortSignal ? abortSignal.reason : undefined;
          if (reason instanceof Error) {
            return reason;
          }
          const err = new Error("aborted");
          err.name = "AbortError";
          return err;
        };
        if (abortSignal.aborted) {
          throw cancelAndCreateError();
        }
        return await Promise.race([
          compact(),
          new Promise<never>((_, reject) => {
            abortSignal.addEventListener(
              "abort",
              () => {
                reject(cancelAndCreateError());
              },
              { once: true },
            );
          }),
        ]);
      },
    ),
    resolveCompactionTimeoutMs: vi.fn(() => 30_000),
  }));

  vi.doMock("./wait-for-idle-before-flush.js", () => ({
    flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
  }));

  vi.doMock("../transcript-policy.js", () => ({
    resolveTranscriptPolicy: vi.fn(() => ({
      allowSyntheticToolResults: false,
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    })),
  }));

  vi.doMock("./extensions.js", () => ({
    buildEmbeddedExtensionFactories: vi.fn(() => []),
  }));

  vi.doMock("./history.js", () => ({
    getDmHistoryLimitFromSessionKey: vi.fn(() => undefined),
    limitHistoryTurns: vi.fn((msgs: unknown[]) => msgs.slice(0, 2)),
  }));

  vi.doMock("../skills.js", () => ({
    applySkillEnvOverrides: vi.fn(() => () => {}),
    applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
    loadWorkspaceSkillEntries: vi.fn(() => []),
    resolveSkillsPromptForRun: vi.fn(() => undefined),
  }));

  vi.doMock("../agent-paths.js", () => ({
    resolveOpenClawAgentDir: vi.fn(() => "/tmp"),
  }));

  vi.doMock("../agent-scope.js", () => ({
    resolveSessionAgentId: resolveSessionAgentIdMock,
    resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  }));

  vi.doMock("../memory-search.js", () => ({
    resolveMemorySearchConfig: resolveMemorySearchConfigMock,
  }));

  vi.doMock("../../plugins/memory-runtime.js", () => ({
    getActiveMemorySearchManager: getMemorySearchManagerMock,
  }));

  vi.doMock("../date-time.js", () => ({
    formatUserTime: vi.fn(() => ""),
    resolveUserTimeFormat: vi.fn(() => ""),
    resolveUserTimezone: vi.fn(() => ""),
  }));

  vi.doMock("../defaults.js", () => ({
    DEFAULT_CONTEXT_TOKENS: 128_000,
    DEFAULT_MODEL: "fake-model",
    DEFAULT_PROVIDER: "openai",
  }));

  vi.doMock("../utils.js", () => ({
    resolveUserPath: vi.fn((p: string) => p),
  }));

  vi.doMock("../../infra/machine-name.js", () => ({
    getMachineDisplayName: vi.fn(async () => "machine"),
  }));

  vi.doMock("../../config/channel-capabilities.js", () => ({
    resolveChannelCapabilities: vi.fn(() => undefined),
  }));

  vi.doMock("../../utils/message-channel.js", async () => {
    const actual = await vi.importActual<typeof import("../../utils/message-channel.js")>(
      "../../utils/message-channel.js",
    );
    return {
      ...actual,
      normalizeMessageChannel: vi.fn(() => undefined),
    };
  });

  vi.doMock("../pi-embedded-helpers.js", () => ({
    ensureSessionHeader: vi.fn(async () => {}),
    pickFallbackThinkingLevel: vi.fn((params: { message?: string; attempted?: Set<string> }) =>
      params.message?.includes("Reasoning is mandatory") && !params.attempted?.has("minimal")
        ? "minimal"
        : undefined,
    ),
    validateAnthropicTurns: vi.fn((m: unknown[]) => m),
    validateGeminiTurns: vi.fn((m: unknown[]) => m),
  }));

  vi.doMock("../pi-project-settings.js", () => ({
    createPreparedEmbeddedPiSettingsManager: vi.fn(() => ({
      getGlobalSettings: vi.fn(() => ({})),
    })),
  }));

  vi.doMock("./sandbox-info.js", () => ({
    buildEmbeddedSandboxInfo: vi.fn(() => undefined),
  }));

  vi.doMock("./model.js", () => ({
    buildModelAliasLines: vi.fn(() => []),
    resolveModel: resolveModelMock,
    resolveModelAsync: vi.fn(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) =>
        resolveModelMock(provider, modelId, agentDir, cfg),
    ),
  }));

  vi.doMock("./session-manager-cache.js", () => ({
    prewarmSessionFile: vi.fn(async () => {}),
    trackSessionManagerAccess: vi.fn(),
  }));

  vi.doMock("./system-prompt.js", () => ({
    applySystemPromptOverrideToSession: vi.fn(),
    buildEmbeddedSystemPrompt: vi.fn(() => ""),
    createSystemPromptOverride: vi.fn(() => () => ""),
  }));

  vi.doMock("./utils.js", () => ({
    describeUnknownError: vi.fn((err: unknown) => String(err)),
    mapThinkingLevel: vi.fn((level?: string) => level ?? "off"),
    resolveExecToolDefaults: vi.fn(() => undefined),
  }));

  const [compactModule, transcriptEvents] = await Promise.all([
    import("./compact.js"),
    import("../../sessions/transcript-events.js"),
  ]);

  return {
    ...compactModule,
    onSessionTranscriptUpdate: transcriptEvents.onSessionTranscriptUpdate,
  };
}
