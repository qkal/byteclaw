import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionModelSwitchError } from "./live-model-switch.js";

const state = vi.hoisted(() => ({
  clearAgentRunContextMock: vi.fn(),
  deliverAgentCommandResultMock: vi.fn(),
  emitAgentEventMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  runAgentAttemptMock: vi.fn(),
  runWithModelFallbackMock: vi.fn(),
  updateSessionStoreAfterAgentRunMock: vi.fn(),
}));

vi.mock("./model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
}));

vi.mock("./command/attempt-execution.js", () => ({
  buildAcpResult: vi.fn(),
  createAcpVisibleTextAccumulator: vi.fn(),
  emitAcpAssistantDelta: vi.fn(),
  emitAcpLifecycleEnd: vi.fn(),
  emitAcpLifecycleError: vi.fn(),
  emitAcpLifecycleStart: vi.fn(),
  persistAcpTurnTranscript: vi.fn(),
  persistSessionEntry: vi.fn(),
  prependInternalEventContext: (_body: string) => _body,
  runAgentAttempt: (...args: unknown[]) => state.runAgentAttemptMock(...args),
  sessionFileHasContent: vi.fn(async () => false),
}));

vi.mock("./command/delivery.js", () => ({
  deliverAgentCommandResult: (...args: unknown[]) => state.deliverAgentCommandResultMock(...args),
}));

vi.mock("./command/run-context.js", () => ({
  resolveAgentRunContext: () => ({
    accountId: "acct",
    currentChannelId: undefined,
    currentThreadTs: undefined,
    groupChannel: undefined,
    groupId: undefined,
    groupSpace: undefined,
    hasRepliedRef: { current: false },
    messageChannel: "test",
    replyToMode: undefined,
  }),
}));

vi.mock("./command/session-store.js", () => ({
  updateSessionStoreAfterAgentRun: (...args: unknown[]) =>
    state.updateSessionStoreAfterAgentRunMock(...args),
}));

vi.mock("./command/session.js", () => ({
  resolveSession: () => ({
    isNewSession: true,
    persistedThinking: undefined,
    persistedVerbose: undefined,
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now() },
    sessionId: "session-1",
    sessionKey: "agent:main",
    sessionStore: {},
    storePath: "/tmp/store.json",
  }),
}));

vi.mock("./command/types.js", () => ({}));

vi.mock("../acp/policy.js", () => ({
  resolveAcpAgentPolicyError: () => null,
  resolveAcpDispatchPolicyError: () => null,
}));

vi.mock("../acp/runtime/errors.js", () => ({
  toAcpRuntimeError: vi.fn(),
}));

vi.mock("../acp/runtime/session-identifiers.js", () => ({
  resolveAcpSessionCwd: () => "/tmp",
}));

vi.mock("../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "low, medium, high",
  formatXHighModelHint: () => "model-x",
  normalizeThinkLevel: (v?: string) => v || undefined,
  normalizeVerboseLevel: (v?: string) => v || undefined,
  supportsXHighThinking: () => false,
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async (params: { config: unknown }) => ({
    diagnostics: [],
    resolvedConfig: params.config,
  }),
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => [],
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        models: {
          "anthropic/claude": {},
          "openai/claude": {},
          "openai/gpt-5.4": {},
        },
      },
    },
  }),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { valid: false },
  }),
  setRuntimeConfigSnapshot: vi.fn(),
}));

vi.mock("../config/sessions.js", () => ({
  mergeSessionEntry: (a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) }),
  resolveAgentIdFromSessionKey: () => "default",
  updateSessionStore: vi.fn(
    async (_path: string, fn: (store: Record<string, unknown>) => unknown) => {
      const store: Record<string, unknown> = {};
      return fn(store);
    },
  ),
}));

vi.mock("../config/sessions/transcript.js", () => ({
  resolveSessionTranscriptFile: async () => ({
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now() },
    sessionFile: "/tmp/session.jsonl",
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  clearAgentRunContext: (...args: unknown[]) => state.clearAgentRunContextMock(...args),
  emitAgentEvent: (...args: unknown[]) => state.emitAgentEventMock(...args),
  registerAgentRunContext: (...args: unknown[]) => state.registerAgentRunContextMock(...args),
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: () => ({}),
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: () => ({ eligible: false }),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("../sessions/level-overrides.js", () => ({
  applyVerboseOverride: vi.fn(),
}));

vi.mock("../sessions/model-overrides.js", () => ({
  applyModelOverrideToSessionEntry: () => ({ updated: false }),
}));

vi.mock("../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../terminal/ansi.js", () => ({
  sanitizeForLog: (s: string) => s,
}));

vi.mock("../utils/message-channel.js", () => ({
  resolveMessageChannel: () => "test",
}));

const resolveEffectiveModelFallbacksMock = vi.fn().mockReturnValue(undefined);
vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => ["default"],
  resolveAgentConfig: () => undefined,
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentSkillsFilter: () => undefined,
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveEffectiveModelFallbacks: resolveEffectiveModelFallbacksMock,
  resolveSessionAgentId: () => "default",
}));

vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: vi.fn(),
}));

vi.mock("./defaults.js", () => ({
  DEFAULT_MODEL: "claude",
  DEFAULT_PROVIDER: "anthropic",
}));

vi.mock("./lanes.js", () => ({
  AGENT_LANE_SUBAGENT: "subagent",
}));

vi.mock("./model-catalog.js", () => ({
  loadModelCatalog: async () => [],
}));

vi.mock("./model-selection.js", () => ({
  buildAllowedModelSet: () => ({
    allowAny: false,
    allowedCatalog: [],
    allowedKeys: new Set<string>(["anthropic/claude", "openai/claude", "openai/gpt-5.4"]),
  }),
  modelKey: (p: string, m: string) => `${p}/${m}`,
  normalizeModelRef: (p: string, m: string) => ({ model: m, provider: p }),
  parseModelRef: (m: string, p: string) => ({ model: m, provider: p }),
  resolveConfiguredModelRef: () => ({ model: "claude", provider: "anthropic" }),
  resolveDefaultModelForAgent: () => ({ model: "claude", provider: "anthropic" }),
  resolveThinkingDefault: () => "low",
}));

vi.mock("./skills.js", () => ({
  buildWorkspaceSkillSnapshot: () => ({}),
}));

vi.mock("./skills/refresh.js", () => ({
  getSkillsSnapshotVersion: () => 0,
}));

vi.mock("./spawned-context.js", () => ({
  normalizeSpawnedRunMetadata: (meta: unknown) => meta ?? {},
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: () => 30_000,
}));

vi.mock("./workspace.js", () => ({
  ensureAgentWorkspace: async () => ({ dir: "/tmp/workspace" }),
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: () => null,
  }),
}));

async function getAgentCommand() {
  return (await import("./agent-command.js")).agentCommand;
}

interface FallbackRunnerParams {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
}

function makeSuccessResult(provider: string, model: string) {
  return {
    meta: {
      aborted: false,
      agentMeta: { model, provider },
      durationMs: 100,
      stopReason: "end_turn",
    },
    payloads: [{ text: "ok" }],
  };
}

describe("agentCommand – LiveSessionModelSwitchError retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.deliverAgentCommandResultMock.mockResolvedValue(undefined);
    state.updateSessionStoreAfterAgentRunMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries with the switched provider/model when LiveSessionModelSwitchError is thrown", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation += 1;
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          model: "gpt-5.4",
          provider: "openai",
        });
      }
      const result = await params.run(params.provider, params.model);
      return {
        attempts: [],
        model: params.model,
        provider: params.provider,
        result,
      };
    });

    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    const agentCommand = await getAgentCommand();
    await agentCommand({
      message: "hello",
      senderIsOwner: true,
      to: "+1234567890",
    });

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);

    const secondCall = state.runWithModelFallbackMock.mock.calls[1]?.[0] as
      | FallbackRunnerParams
      | undefined;
    expect(secondCall?.provider).toBe("openai");
    expect(secondCall?.model).toBe("gpt-5.4");
  });

  it("propagates non-LiveSessionModelSwitchError errors without retrying", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error("some other failure"));

    const agentCommand = await getAgentCommand();
    await expect(
      agentCommand({
        message: "hello",
        senderIsOwner: true,
        to: "+1234567890",
      }),
    ).rejects.toThrow("some other failure");

    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(1);
  });

  it("emits lifecycle error event for non-switch errors", async () => {
    state.runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider down"));

    const agentCommand = await getAgentCommand();
    await expect(
      agentCommand({
        message: "hello",
        senderIsOwner: true,
        to: "+1234567890",
      }),
    ).rejects.toThrow("provider down");

    const lifecycleErrorCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "error";
    });
    expect(lifecycleErrorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("resets lifecycleEnded flag between retry iterations", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation += 1;
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          model: "gpt-5.4",
          provider: "openai",
        });
      }
      const result = await params.run(params.provider, params.model);
      return {
        attempts: [],
        model: params.model,
        provider: params.provider,
        result,
      };
    });

    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    const agentCommand = await getAgentCommand();
    await agentCommand({
      message: "hello",
      senderIsOwner: true,
      to: "+1234567890",
    });

    const lifecycleEndCalls = state.emitAgentEventMock.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as { stream?: string; data?: { phase?: string } };
      return arg?.stream === "lifecycle" && arg?.data?.phase === "end";
    });
    expect(lifecycleEndCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("propagates authProfileId from the switch error to the retried session entry", async () => {
    let invocation = 0;
    let capturedAuthProfileProvider: string | undefined;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation += 1;
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          authProfileId: "profile-openai-prod",
          authProfileIdSource: "user",
          model: "gpt-5.4",
          provider: "openai",
        });
      }
      const result = await params.run(params.provider, params.model);
      return {
        attempts: [],
        model: params.model,
        provider: params.provider,
        result,
      };
    });

    state.runAgentAttemptMock.mockImplementation(async (...args: unknown[]) => {
      const attemptParams = args[0] as { authProfileProvider?: string } | undefined;
      capturedAuthProfileProvider = attemptParams?.authProfileProvider;
      return makeSuccessResult("openai", "gpt-5.4");
    });

    const agentCommand = await getAgentCommand();
    await agentCommand({
      message: "hello",
      senderIsOwner: true,
      to: "+1234567890",
    });

    expect(capturedAuthProfileProvider).toBe("openai");
    expect(state.runWithModelFallbackMock).toHaveBeenCalledTimes(2);
  });

  it("updates hasSessionModelOverride for fallback resolution after switch", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation += 1;
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          model: "gpt-5.4",
          provider: "openai",
        });
      }
      const result = await params.run(params.provider, params.model);
      return {
        attempts: [],
        model: params.model,
        provider: params.provider,
        result,
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    resolveEffectiveModelFallbacksMock.mockClear();

    const agentCommand = await getAgentCommand();
    await agentCommand({
      message: "hello",
      senderIsOwner: true,
      to: "+1234567890",
    });

    expect(resolveEffectiveModelFallbacksMock).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveModelFallbacksMock.mock.calls[0][0]).toMatchObject({
      hasSessionModelOverride: false,
    });
    expect(resolveEffectiveModelFallbacksMock.mock.calls[1][0]).toMatchObject({
      hasSessionModelOverride: true,
    });
  });

  it("does not flip hasSessionModelOverride on auth-only switch with same model", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation += 1;
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          authProfileId: "profile-99",
          authProfileIdSource: "user",
          model: "claude",
          provider: "anthropic",
        });
      }
      const result = await params.run(params.provider, params.model);
      return {
        attempts: [],
        model: params.model,
        provider: params.provider,
        result,
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    resolveEffectiveModelFallbacksMock.mockClear();

    const agentCommand = await getAgentCommand();
    await agentCommand({
      message: "hello",
      senderIsOwner: true,
      to: "+1234567890",
    });

    expect(resolveEffectiveModelFallbacksMock).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveModelFallbacksMock.mock.calls[0][0]).toMatchObject({
      hasSessionModelOverride: false,
    });
    expect(resolveEffectiveModelFallbacksMock.mock.calls[1][0]).toMatchObject({
      hasSessionModelOverride: false,
    });
  });

  it("flips hasSessionModelOverride on provider-only switch with same model", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation += 1;
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          model: "claude",
          provider: "openai",
        });
      }
      const result = await params.run(params.provider, params.model);
      return {
        attempts: [],
        model: params.model,
        provider: params.provider,
        result,
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "claude"));

    resolveEffectiveModelFallbacksMock.mockClear();

    const agentCommand = await getAgentCommand();
    await agentCommand({
      message: "hello",
      senderIsOwner: true,
      to: "+1234567890",
    });

    expect(resolveEffectiveModelFallbacksMock).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveModelFallbacksMock.mock.calls[0][0]).toMatchObject({
      hasSessionModelOverride: false,
    });
    expect(resolveEffectiveModelFallbacksMock.mock.calls[1][0]).toMatchObject({
      hasSessionModelOverride: true,
    });
  });
});
