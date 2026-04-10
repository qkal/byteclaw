import { type Mock, vi } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { FailoverReason } from "../pi-embedded-helpers/types.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

type MockCompactionResult =
  | {
      ok: true;
      compacted: true;
      result: {
        summary: string;
        firstKeptEntryId?: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
      reason?: string;
    }
  | {
      ok: false;
      compacted: false;
      reason: string;
      result?: undefined;
    };

export const mockedGlobalHookRunner = {
  hasHooks: vi.fn((_hookName: string) => false),
  runAfterCompaction: vi.fn(async () => undefined),
  runBeforeAgentStart: vi.fn(
    async (
      _event: { prompt: string; messages?: unknown[] },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeAgentStartResult | undefined> => undefined,
  ),
  runBeforeCompaction: vi.fn(async () => undefined),
  runBeforeModelResolve: vi.fn(
    async (
      _event: { prompt: string },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforeModelResolveResult | undefined> => undefined,
  ),
  runBeforePromptBuild: vi.fn(
    async (
      _event: { prompt: string; messages: unknown[] },
      _ctx: PluginHookAgentContext,
    ): Promise<PluginHookBeforePromptBuildResult | undefined> => undefined,
  ),
};

export const mockedContextEngine = {
  compact: vi.fn<(params: unknown) => Promise<MockCompactionResult>>(async () => ({
    compacted: false as const,
    ok: false as const,
    reason: "nothing to compact",
  })),
  info: { ownsCompaction: false as boolean },
};

export const mockedContextEngineCompact = mockedContextEngine.compact;
export const mockedCompactDirect = mockedContextEngine.compact;
export const mockedRunPostCompactionSideEffects = vi.fn(async () => {});
export const mockedEnsureRuntimePluginsLoaded = vi.fn<(params?: unknown) => void>();
export const mockedPrepareProviderRuntimeAuth = vi.fn(async () => undefined);
export const mockedRunEmbeddedAttempt =
  vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
export const mockedRunContextEngineMaintenance = vi.fn(async () => undefined);
export const mockedSessionLikelyHasOversizedToolResults = vi.fn(() => false);
interface MockTruncateOversizedToolResultsResult {
  truncated: boolean;
  truncatedCount: number;
  reason?: string;
}
export const mockedTruncateOversizedToolResultsInSession = vi.fn<
  () => Promise<MockTruncateOversizedToolResultsResult>
>(async () => ({
  reason: "no oversized tool results",
  truncated: false,
  truncatedCount: 0,
}));

interface MockFailoverErrorDescription {
  message: string;
  reason: string | undefined;
  status: number | undefined;
  code: string | undefined;
}

type MockCoerceToFailoverError = (
  err: unknown,
  params?: { provider?: string; model?: string; profileId?: string },
) => unknown;
type MockDescribeFailoverError = (err: unknown) => MockFailoverErrorDescription;
type MockResolveFailoverStatus = (reason: string) => number | undefined;
export class MockedFailoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailoverError";
  }
}

export const mockedCoerceToFailoverError = vi.fn<MockCoerceToFailoverError>();
export const mockedDescribeFailoverError = vi.fn<MockDescribeFailoverError>(
  (err: unknown): MockFailoverErrorDescription => ({
    code: undefined,
    message: formatErrorMessage(err),
    reason: undefined,
    status: undefined,
  }),
);
export const mockedResolveFailoverStatus = vi.fn<MockResolveFailoverStatus>();

export const mockedLog: {
  debug: Mock<(...args: unknown[]) => void>;
  info: Mock<(...args: unknown[]) => void>;
  warn: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  isEnabled: Mock<(level?: string) => boolean>;
} = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  warn: vi.fn(),
};

export const mockedFormatBillingErrorMessage = vi.fn(() => "");
export const mockedClassifyFailoverReason = vi.fn<(raw: string) => FailoverReason | null>(
  () => null,
);
export const mockedExtractObservedOverflowTokenCount = vi.fn((msg?: string) => {
  const match = msg?.match(/prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i);
  return match?.[1] ? Number(match[1].replaceAll(",", "")) : undefined;
});
export const mockedFormatAssistantErrorText = vi.fn(() => "");
export const mockedIsAuthAssistantError = vi.fn(() => false);
export const mockedIsBillingAssistantError = vi.fn(() => false);
export const mockedIsCompactionFailureError = vi.fn(() => false);
export const mockedIsFailoverAssistantError = vi.fn(() => false);
export const mockedIsFailoverErrorMessage = vi.fn(() => false);
export const mockedIsLikelyContextOverflowError = vi.fn((msg?: string) => {
  const lower = normalizeLowercaseStringOrEmpty(msg ?? "");
  return (
    lower.includes("request_too_large") ||
    lower.includes("context window exceeded") ||
    lower.includes("prompt is too long")
  );
});
export const mockedParseImageSizeError = vi.fn(() => null);
export const mockedParseImageDimensionError = vi.fn(() => null);
export const mockedIsRateLimitAssistantError = vi.fn(() => false);
export const mockedIsTimeoutErrorMessage = vi.fn(() => false);
export const mockedPickFallbackThinkingLevel = vi.fn<(params?: unknown) => ThinkLevel | null>(
  () => null,
);
export const mockedEvaluateContextWindowGuard = vi.fn(() => ({
  shouldBlock: false,
  shouldWarn: false,
  source: "model",
  tokens: 200_000,
}));
export const mockedResolveContextWindowInfo = vi.fn(() => ({
  source: "model",
  tokens: 200_000,
}));
export const mockedGetApiKeyForModel = vi.fn(
  async ({ profileId }: { profileId?: string } = {}) => ({
    apiKey: "test-key",
    mode: "api-key" as const,
    profileId: profileId ?? "test-profile",
    source: "test",
  }),
);
export const mockedResolveAuthProfileOrder = vi.fn(() => [] as string[]);
export const mockedShouldPreferExplicitConfigApiKeyAuth = vi.fn(() => false);

export const overflowBaseRunParams = {
  prompt: "hello",
  runId: "run-1",
  sessionFile: "/tmp/session.json",
  sessionId: "test-session",
  sessionKey: "test-key",
  timeoutMs: 30_000,
  workspaceDir: "/tmp/workspace",
} as const;

export function resetRunOverflowCompactionHarnessMocks(): void {
  mockedGlobalHookRunner.hasHooks.mockReset();
  mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
  mockedGlobalHookRunner.runBeforeAgentStart.mockReset();
  mockedGlobalHookRunner.runBeforeAgentStart.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforePromptBuild.mockReset();
  mockedGlobalHookRunner.runBeforePromptBuild.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforeModelResolve.mockReset();
  mockedGlobalHookRunner.runBeforeModelResolve.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runBeforeCompaction.mockReset();
  mockedGlobalHookRunner.runBeforeCompaction.mockResolvedValue(undefined);
  mockedGlobalHookRunner.runAfterCompaction.mockReset();
  mockedGlobalHookRunner.runAfterCompaction.mockResolvedValue(undefined);

  mockedContextEngine.info.ownsCompaction = false;
  mockedContextEngineCompact.mockReset();
  mockedContextEngineCompact.mockResolvedValue({
    compacted: false,
    ok: false,
    reason: "nothing to compact",
  });

  mockedEnsureRuntimePluginsLoaded.mockReset();
  mockedPrepareProviderRuntimeAuth.mockReset();
  mockedPrepareProviderRuntimeAuth.mockResolvedValue(undefined);
  mockedRunEmbeddedAttempt.mockReset();
  mockedRunContextEngineMaintenance.mockReset();
  mockedRunContextEngineMaintenance.mockResolvedValue(undefined);
  mockedSessionLikelyHasOversizedToolResults.mockReset();
  mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
  mockedTruncateOversizedToolResultsInSession.mockReset();
  mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
    reason: "no oversized tool results",
    truncated: false,
    truncatedCount: 0,
  });

  mockedCoerceToFailoverError.mockReset();
  mockedCoerceToFailoverError.mockReturnValue(null);
  mockedDescribeFailoverError.mockReset();
  mockedDescribeFailoverError.mockImplementation(
    (err: unknown): MockFailoverErrorDescription => ({
      code: undefined,
      message: formatErrorMessage(err),
      reason: undefined,
      status: undefined,
    }),
  );
  mockedResolveFailoverStatus.mockReset();
  mockedResolveFailoverStatus.mockReturnValue(undefined);

  mockedLog.debug.mockReset();
  mockedLog.info.mockReset();
  mockedLog.warn.mockReset();
  mockedLog.error.mockReset();
  mockedLog.isEnabled.mockReset();
  mockedLog.isEnabled.mockReturnValue(false);

  mockedClassifyFailoverReason.mockReset();
  mockedClassifyFailoverReason.mockReturnValue(null);
  mockedFormatBillingErrorMessage.mockReset();
  mockedFormatBillingErrorMessage.mockReturnValue("");
  mockedFormatAssistantErrorText.mockReset();
  mockedFormatAssistantErrorText.mockReturnValue("");
  mockedIsAuthAssistantError.mockReset();
  mockedIsAuthAssistantError.mockReturnValue(false);
  mockedIsBillingAssistantError.mockReset();
  mockedIsBillingAssistantError.mockReturnValue(false);
  mockedExtractObservedOverflowTokenCount.mockReset();
  mockedExtractObservedOverflowTokenCount.mockImplementation((msg?: string) => {
    const match = msg?.match(/prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i);
    return match?.[1] ? Number(match[1].replaceAll(",", "")) : undefined;
  });
  mockedIsCompactionFailureError.mockReset();
  mockedIsCompactionFailureError.mockReturnValue(false);
  mockedIsFailoverAssistantError.mockReset();
  mockedIsFailoverAssistantError.mockReturnValue(false);
  mockedIsFailoverErrorMessage.mockReset();
  mockedIsFailoverErrorMessage.mockReturnValue(false);
  mockedIsLikelyContextOverflowError.mockReset();
  mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
    const lower = normalizeLowercaseStringOrEmpty(msg ?? "");
    return (
      lower.includes("request_too_large") ||
      lower.includes("context window exceeded") ||
      lower.includes("prompt is too long")
    );
  });
  mockedParseImageSizeError.mockReset();
  mockedParseImageSizeError.mockReturnValue(null);
  mockedParseImageDimensionError.mockReset();
  mockedParseImageDimensionError.mockReturnValue(null);
  mockedIsRateLimitAssistantError.mockReset();
  mockedIsRateLimitAssistantError.mockReturnValue(false);
  mockedIsTimeoutErrorMessage.mockReset();
  mockedIsTimeoutErrorMessage.mockReturnValue(false);
  mockedPickFallbackThinkingLevel.mockReset();
  mockedPickFallbackThinkingLevel.mockReturnValue(null);
  mockedEvaluateContextWindowGuard.mockReset();
  mockedEvaluateContextWindowGuard.mockReturnValue({
    shouldBlock: false,
    shouldWarn: false,
    source: "model",
    tokens: 200_000,
  });
  mockedResolveContextWindowInfo.mockReset();
  mockedResolveContextWindowInfo.mockReturnValue({
    source: "model",
    tokens: 200_000,
  });
  mockedGetApiKeyForModel.mockReset();
  mockedGetApiKeyForModel.mockImplementation(
    async ({ profileId }: { profileId?: string } = {}) => ({
      apiKey: "test-key",
      mode: "api-key",
      profileId: profileId ?? "test-profile",
      source: "test",
    }),
  );
  mockedResolveAuthProfileOrder.mockReset();
  mockedResolveAuthProfileOrder.mockReturnValue([]);
  mockedShouldPreferExplicitConfigApiKeyAuth.mockReset();
  mockedShouldPreferExplicitConfigApiKeyAuth.mockReturnValue(false);
  mockedRunPostCompactionSideEffects.mockReset();
  mockedRunPostCompactionSideEffects.mockResolvedValue(undefined);
}

export async function loadRunOverflowCompactionHarness(): Promise<{
  runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
}> {
  resetRunOverflowCompactionHarnessMocks();
  vi.resetModules();

  vi.doMock("../../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: vi.fn(() => mockedGlobalHookRunner),
  }));

  vi.doMock("../../context-engine/index.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
    resolveContextEngine: vi.fn(async () => mockedContextEngine),
  }));

  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded: mockedEnsureRuntimePluginsLoaded,
  }));

  vi.doMock("../../plugins/provider-runtime.js", () => ({
    prepareProviderExtraParams: vi.fn(async () => ({})),
    prepareProviderRuntimeAuth: mockedPrepareProviderRuntimeAuth,
    resolveProviderCapabilitiesWithPlugin: vi.fn(() => ({})),
    wrapProviderStreamFn: vi.fn((_cfg: unknown, _model: unknown, fn: unknown) => fn),
  }));

  vi.doMock("../auth-profiles.js", () => ({
    isProfileInCooldown: vi.fn(() => false),
    markAuthProfileFailure: vi.fn(async () => {}),
    markAuthProfileGood: vi.fn(async () => {}),
    markAuthProfileUsed: vi.fn(async () => {}),
    resolveProfilesUnavailableReason: vi.fn(() => undefined),
  }));

  vi.doMock("../usage.js", () => ({
    derivePromptTokens: vi.fn(
      (usage?: { input?: number; cacheRead?: number; cacheWrite?: number }) =>
        usage
          ? (() => {
              const sum = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
              return sum > 0 ? sum : undefined;
            })()
          : undefined,
    ),
    normalizeUsage: vi.fn((usage?: unknown) =>
      usage && typeof usage === "object" ? usage : undefined,
    ),
  }));

  vi.doMock("../workspace-run.js", () => ({
    redactRunIdentifier: vi.fn((value?: string) => value ?? ""),
    resolveRunWorkspaceDir: vi.fn((params: { workspaceDir: string }) => ({
      agentId: "main",
      fallbackReason: undefined,
      usedFallback: false,
      workspaceDir: params.workspaceDir,
    })),
  }));

  vi.doMock("../pi-embedded-helpers.js", () => ({
    classifyFailoverReason: mockedClassifyFailoverReason,
    extractObservedOverflowTokenCount: mockedExtractObservedOverflowTokenCount,
    formatAssistantErrorText: mockedFormatAssistantErrorText,
    formatBillingErrorMessage: mockedFormatBillingErrorMessage,
    isAuthAssistantError: mockedIsAuthAssistantError,
    isBillingAssistantError: mockedIsBillingAssistantError,
    isCompactionFailureError: mockedIsCompactionFailureError,
    isFailoverAssistantError: mockedIsFailoverAssistantError,
    isFailoverErrorMessage: mockedIsFailoverErrorMessage,
    isLikelyContextOverflowError: mockedIsLikelyContextOverflowError,
    isRateLimitAssistantError: mockedIsRateLimitAssistantError,
    isTimeoutErrorMessage: mockedIsTimeoutErrorMessage,
    parseImageDimensionError: mockedParseImageDimensionError,
    parseImageSizeError: mockedParseImageSizeError,
    pickFallbackThinkingLevel: mockedPickFallbackThinkingLevel,
    sanitizeUserFacingText: vi.fn((text: unknown) => (typeof text === "string" ? text : "")),
  }));

  vi.doMock("./run/attempt.js", () => ({
    runEmbeddedAttempt: mockedRunEmbeddedAttempt,
  }));

  vi.doMock("./tool-result-truncation.js", () => ({
    sessionLikelyHasOversizedToolResults: mockedSessionLikelyHasOversizedToolResults,
    truncateOversizedToolResultsInSession: mockedTruncateOversizedToolResultsInSession,
  }));

  vi.doMock("./context-engine-maintenance.js", () => ({
    runContextEngineMaintenance: mockedRunContextEngineMaintenance,
  }));

  vi.doMock("./model.js", () => ({
    resolveModelAsync: vi.fn(async () => ({
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      error: null,
      model: {
        api: "messages",
        contextWindow: 200_000,
        id: "test-model",
        provider: "anthropic",
      },
      modelRegistry: {},
    })),
  }));

  vi.doMock("../model-auth.js", () => ({
    applyAuthHeaderOverride: vi.fn((model: unknown) => model),
    applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
    ensureAuthProfileStore: vi.fn(() => ({})),
    getApiKeyForModel: mockedGetApiKeyForModel,
    resolveAuthProfileOrder: mockedResolveAuthProfileOrder,
    shouldPreferExplicitConfigApiKeyAuth: mockedShouldPreferExplicitConfigApiKeyAuth,
  }));

  vi.doMock("../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => {}),
  }));

  vi.doMock("../context-window-guard.js", () => ({
    CONTEXT_WINDOW_HARD_MIN_TOKENS: 1000,
    CONTEXT_WINDOW_WARN_BELOW_TOKENS: 5000,
    evaluateContextWindowGuard: mockedEvaluateContextWindowGuard,
    resolveContextWindowInfo: mockedResolveContextWindowInfo,
  }));

  vi.doMock("../../process/command-queue.js", () => ({
    enqueueCommandInLane: vi.fn((_lane: string, task: () => unknown) => task()),
  }));

  vi.doMock("../../utils/message-channel.js", () => ({
    isMarkdownCapableMessageChannel: vi.fn(() => true),
  }));

  vi.doMock("../agent-paths.js", () => ({
    resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
  }));

  vi.doMock("../defaults.js", () => ({
    DEFAULT_CONTEXT_TOKENS: 200_000,
    DEFAULT_MODEL: "test-model",
    DEFAULT_PROVIDER: "anthropic",
  }));

  vi.doMock("../failover-error.js", () => ({
    FailoverError: MockedFailoverError,
    coerceToFailoverError: mockedCoerceToFailoverError,
    describeFailoverError: mockedDescribeFailoverError,
    resolveFailoverStatus: mockedResolveFailoverStatus,
  }));

  vi.doMock("./lanes.js", () => ({
    resolveGlobalLane: vi.fn(() => "global-lane"),
    resolveSessionLane: vi.fn(() => "session-lane"),
  }));

  vi.doMock("./logger.js", () => ({
    log: mockedLog,
  }));

  vi.doMock("./run/payloads.js", () => ({
    buildEmbeddedRunPayloads: vi.fn(() => []),
  }));

  vi.doMock("./compact.js", () => ({
    runPostCompactionSideEffects: mockedRunPostCompactionSideEffects,
  }));

  vi.doMock("./utils.js", () => ({
    describeUnknownError: vi.fn((err: unknown) => {
      if (err instanceof Error) {
        return err.message;
      }
      return String(err);
    }),
  }));

  const { runEmbeddedPiAgent } = await import("./run.js");
  return { runEmbeddedPiAgent };
}
