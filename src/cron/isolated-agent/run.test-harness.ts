import { type Mock, vi } from "vitest";
import { resolveFastModeState as resolveFastModeStateImpl } from "../../agents/fast-mode.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

interface CronSessionEntry {
  sessionId: string;
  updatedAt: number;
  systemSent: boolean;
  skillsSnapshot: unknown;
  model?: string;
  modelProvider?: string;
  [key: string]: unknown;
}

interface CronSession {
  storePath: string;
  store: Record<string, unknown>;
  sessionEntry: CronSessionEntry;
  systemSent: boolean;
  isNewSession: boolean;
  [key: string]: unknown;
}

function createMock(): Mock {
  return vi.fn();
}

function normalizeModelSelectionForTest(value: unknown): string | undefined {
  const direct = normalizeOptionalString(value);
  if (direct) {
    return direct;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as { primary?: unknown }).primary);
}

export const buildWorkspaceSkillSnapshotMock = createMock();
export const resolveAgentConfigMock = createMock();
export const resolveEffectiveModelFallbacksMock = createMock();
export const resolveAgentModelFallbacksOverrideMock = createMock();
export const resolveAgentSkillsFilterMock = createMock();
export const getModelRefStatusMock = createMock();
export const isCliProviderMock = createMock();
export const resolveAllowedModelRefMock = createMock();
export const resolveConfiguredModelRefMock = createMock();
export const resolveHooksGmailModelMock = createMock();
export const resolveThinkingDefaultMock = createMock();
export const runWithModelFallbackMock = createMock();
export const runEmbeddedPiAgentMock = createMock();
export const runCliAgentMock = createMock();
export const lookupContextTokensMock = createMock();
export const getCliSessionIdMock = createMock();
export const updateSessionStoreMock = createMock();
export const resolveCronSessionMock = createMock();
export const logWarnMock = createMock();
export const countActiveDescendantRunsMock = createMock();
export const listDescendantRunsForRequesterMock = createMock();
export const pickLastNonEmptyTextFromPayloadsMock = createMock();
export const resolveCronPayloadOutcomeMock = createMock();
export const resolveCronDeliveryPlanMock = createMock();
export const resolveDeliveryTargetMock = createMock();
export const dispatchCronDeliveryMock = createMock();
export const isHeartbeatOnlyResponseMock = createMock();
export const resolveHeartbeatAckMaxCharsMock = createMock();
export const resolveSessionAuthProfileOverrideMock = createMock();
export const resolveFastModeStateMock = createMock();

const resolveBootstrapWarningSignaturesSeenMock = createMock();
const resolveCronStyleNowMock = createMock();
const resolveNestedAgentLaneMock = createMock();
const resolveAgentTimeoutMsMock = createMock();
const deriveSessionTotalTokensMock = createMock();
const hasNonzeroUsageMock = createMock();
const ensureAgentWorkspaceMock = createMock();
const normalizeThinkLevelMock = createMock();
const normalizeVerboseLevelMock = createMock();
const supportsXHighThinkingMock = createMock();
const resolveSessionTranscriptPathMock = createMock();
const setSessionRuntimeModelMock = createMock();
const registerAgentRunContextMock = createMock();
const buildSafeExternalPromptMock = createMock();
const detectSuspiciousPatternsMock = createMock();
const mapHookExternalContentSourceMock = createMock();
const isExternalHookSessionMock = createMock();
const resolveHookExternalContentSourceMock = createMock();
const getSkillsSnapshotVersionMock = createMock();
const loadModelCatalogMock = createMock();
const getRemoteSkillEligibilityMock = createMock();

vi.mock("./run.runtime.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128_000,
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  DEFAULT_MODEL: "gpt-4",
  DEFAULT_PROVIDER: "openai",
  buildSafeExternalPrompt: buildSafeExternalPromptMock,
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  deriveSessionTotalTokens: deriveSessionTotalTokensMock,
  detectSuspiciousPatterns: detectSuspiciousPatternsMock,
  ensureAgentWorkspace: ensureAgentWorkspaceMock,
  getModelRefStatus: getModelRefStatusMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  hasNonzeroUsage: hasNonzeroUsageMock,
  isCliProvider: isCliProviderMock,
  isExternalHookSession: isExternalHookSessionMock,
  loadModelCatalog: loadModelCatalogMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  lookupContextTokens: lookupContextTokensMock,
  mapHookExternalContentSource: mapHookExternalContentSourceMock,
  normalizeAgentId: vi.fn((id: string) => id),
  normalizeModelSelection: normalizeModelSelectionForTest,
  normalizeThinkLevel: normalizeThinkLevelMock,
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentModelFallbacksOverride: resolveAgentModelFallbacksOverrideMock,
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
  resolveAgentTimeoutMs: resolveAgentTimeoutMsMock,
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveCronStyleNow: resolveCronStyleNowMock,
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveHookExternalContentSource: resolveHookExternalContentSourceMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
  resolveSessionAuthProfileOverride: resolveSessionAuthProfileOverrideMock,
  resolveThinkingDefault: resolveThinkingDefaultMock,
  setCliSessionId: vi.fn(),
  setSessionRuntimeModel: setSessionRuntimeModelMock,
  supportsXHighThinking: supportsXHighThinkingMock,
}));

vi.mock("./run-execution.runtime.js", () => ({
  LiveSessionModelSwitchError,
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  getCliSessionId: getCliSessionIdMock,
  isCliProvider: isCliProviderMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  normalizeVerboseLevel: normalizeVerboseLevelMock,
  registerAgentRunContext: registerAgentRunContextMock,
  resolveBootstrapWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeenMock,
  resolveEffectiveModelFallbacks: resolveEffectiveModelFallbacksMock,
  resolveFastModeState: resolveFastModeStateMock,
  resolveNestedAgentLane: resolveNestedAgentLaneMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  runCliAgent: runCliAgentMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  runWithModelFallback: runWithModelFallbackMock,
}));

vi.mock("../../agents/cli-runner.runtime.js", () => ({
  setCliSessionId: vi.fn(),
}));

vi.mock("../../config/sessions/store.runtime.js", () => ({
  updateSessionStore: updateSessionStoreMock,
}));

vi.mock("../delivery-plan.js", () => ({
  resolveCronDeliveryPlan: resolveCronDeliveryPlanMock,
}));

vi.mock("./delivery-target.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

vi.mock("./delivery-dispatch.js", async () => {
  const actual =
    await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js");
  return {
    ...actual,
    dispatchCronDelivery: dispatchCronDeliveryMock,
  };
});

vi.mock("./helpers.js", () => ({
  isHeartbeatOnlyResponse: isHeartbeatOnlyResponseMock,
  pickLastDeliverablePayload: vi.fn().mockReturnValue(undefined),
  pickLastNonEmptyTextFromPayloads: pickLastNonEmptyTextFromPayloadsMock,
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  pickSummaryFromPayloads: vi.fn().mockReturnValue("summary"),
  resolveCronPayloadOutcome: resolveCronPayloadOutcomeMock,
  resolveHeartbeatAckMaxChars: resolveHeartbeatAckMaxCharsMock,
}));

vi.mock("./session.js", () => ({
  resolveCronSession: resolveCronSessionMock,
}));

export function makeCronSessionEntry(overrides?: Record<string, unknown>): CronSessionEntry {
  return {
    sessionId: "test-session-id",
    skillsSnapshot: undefined,
    systemSent: false,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeCronSession(overrides?: Record<string, unknown>): CronSession {
  return {
    isNewSession: true,
    sessionEntry: makeCronSessionEntry(),
    store: {},
    storePath: "/tmp/store.json",
    systemSent: false,
    ...overrides,
  } as CronSession;
}

function makeDefaultModelFallbackResult() {
  return {
    model: "gpt-4",
    provider: "openai",
    result: {
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      payloads: [{ text: "test output" }],
    },
  };
}

function makeDefaultEmbeddedResult() {
  return {
    meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    payloads: [{ text: "test output" }],
  };
}

export function mockRunCronFallbackPassthrough(): void {
  runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
    const result = await run(provider, model);
    return { attempts: [], model, provider, result };
  });
}

function resetRunConfigMocks(): void {
  buildWorkspaceSkillSnapshotMock.mockReturnValue({
    prompt: "<available_skills></available_skills>",
    resolvedSkills: [],
    version: 42,
  });
  resolveAgentConfigMock.mockReturnValue(undefined);
  resolveEffectiveModelFallbacksMock.mockReset();
  resolveEffectiveModelFallbacksMock.mockImplementation(
    ({ cfg, agentId, hasSessionModelOverride }) => {
      const agentFallbacksOverride = resolveAgentModelFallbacksOverrideMock(cfg, agentId) as
        | string[]
        | undefined;
      if (!hasSessionModelOverride) {
        return agentFallbacksOverride;
      }
      const defaultFallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.model);
      return agentFallbacksOverride ?? defaultFallbacks;
    },
  );
  resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
  resolveAgentSkillsFilterMock.mockReturnValue(undefined);
  resolveConfiguredModelRefMock.mockReturnValue({ model: "gpt-4", provider: "openai" });
  resolveAllowedModelRefMock.mockReturnValue({ ref: { model: "gpt-4", provider: "openai" } });
  resolveHooksGmailModelMock.mockReturnValue(null);
  resolveThinkingDefaultMock.mockReturnValue("off");
  getModelRefStatusMock.mockReturnValue({ allowed: false });
  resolveCronStyleNowMock.mockReturnValue({
    formattedTime: "2026-02-10 12:00",
    timeLine: "Current time: 2026-02-10 12:00 UTC",
  });
  resolveAgentTimeoutMsMock.mockReturnValue(60_000);
  deriveSessionTotalTokensMock.mockReturnValue(30);
  hasNonzeroUsageMock.mockReturnValue(true);
  ensureAgentWorkspaceMock.mockResolvedValue({ dir: "/tmp/workspace" });
  normalizeThinkLevelMock.mockImplementation((value: unknown) => value);
  supportsXHighThinkingMock.mockReturnValue(false);
  buildSafeExternalPromptMock.mockImplementation(
    ({ message }: { message?: string }) => message ?? "",
  );
  detectSuspiciousPatternsMock.mockReturnValue([]);
  mapHookExternalContentSourceMock.mockReturnValue("unknown");
  isExternalHookSessionMock.mockReturnValue(false);
  resolveHookExternalContentSourceMock.mockReturnValue(undefined);
  getSkillsSnapshotVersionMock.mockReturnValue(42);
  loadModelCatalogMock.mockResolvedValue({ models: [] });
  getRemoteSkillEligibilityMock.mockResolvedValue({ remoteSkillsEnabled: false });
}

function resetRunExecutionMocks(): void {
  isCliProviderMock.mockReturnValue(false);
  resolveBootstrapWarningSignaturesSeenMock.mockReturnValue(new Set());
  resolveFastModeStateMock.mockImplementation((params) => resolveFastModeStateImpl(params));
  resolveNestedAgentLaneMock.mockReturnValue(undefined);
  normalizeVerboseLevelMock.mockImplementation((value: unknown) => value ?? "off");
  resolveSessionTranscriptPathMock.mockReturnValue("/tmp/transcript.jsonl");
  registerAgentRunContextMock.mockReturnValue(undefined);
  runWithModelFallbackMock.mockReset();
  runWithModelFallbackMock.mockResolvedValue(makeDefaultModelFallbackResult());
  runEmbeddedPiAgentMock.mockReset();
  runEmbeddedPiAgentMock.mockResolvedValue(makeDefaultEmbeddedResult());
  runCliAgentMock.mockReset();
  getCliSessionIdMock.mockReturnValue(undefined);
  countActiveDescendantRunsMock.mockReset();
  countActiveDescendantRunsMock.mockReturnValue(0);
  listDescendantRunsForRequesterMock.mockReset();
  listDescendantRunsForRequesterMock.mockReturnValue([]);
}

function resetRunOutcomeMocks(): void {
  lookupContextTokensMock.mockReset();
  lookupContextTokensMock.mockReturnValue(undefined);
  pickLastNonEmptyTextFromPayloadsMock.mockReset();
  pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("test output");
  resolveCronPayloadOutcomeMock.mockReset();
  resolveCronPayloadOutcomeMock.mockImplementation(
    ({ payloads }: { payloads: { isError?: boolean }[] }) => {
      const outputText = pickLastNonEmptyTextFromPayloadsMock(payloads);
      const synthesizedText = outputText?.trim() || "summary";
      const hasFatalErrorPayload = payloads.some((payload) => payload?.isError === true);
      return {
        deliveryPayload: undefined,
        deliveryPayloadHasStructuredContent: false,
        deliveryPayloads: synthesizedText ? [{ text: synthesizedText }] : [],
        embeddedRunError: hasFatalErrorPayload
          ? "cron isolated run returned an error payload"
          : undefined,
        hasFatalErrorPayload,
        outputText,
        summary: "summary",
        synthesizedText,
      };
    },
  );
  resolveCronDeliveryPlanMock.mockReset();
  resolveCronDeliveryPlanMock.mockReturnValue({ mode: "none", requested: false });
  resolveDeliveryTargetMock.mockReset();
  resolveDeliveryTargetMock.mockResolvedValue({
    accountId: undefined,
    channel: "discord",
    error: undefined,
    to: undefined,
  });
  dispatchCronDeliveryMock.mockReset();
  dispatchCronDeliveryMock.mockImplementation(
    ({
      deliveryPayloads,
      summary,
      outputText,
      synthesizedText,
      deliveryRequested,
      skipHeartbeatDelivery,
      skipMessagingToolDelivery,
    }) => ({
      delivered: Boolean(deliveryRequested && !skipHeartbeatDelivery && !skipMessagingToolDelivery),
      deliveryAttempted: Boolean(
        deliveryRequested && !skipHeartbeatDelivery && !skipMessagingToolDelivery,
      ),
      deliveryPayloads,
      outputText,
      result: undefined,
      summary,
      synthesizedText,
    }),
  );
  isHeartbeatOnlyResponseMock.mockReset();
  isHeartbeatOnlyResponseMock.mockReturnValue(false);
  resolveHeartbeatAckMaxCharsMock.mockReset();
  resolveHeartbeatAckMaxCharsMock.mockReturnValue(100);
  resolveSessionAuthProfileOverrideMock.mockReset();
  resolveSessionAuthProfileOverrideMock.mockResolvedValue(undefined);
}

function resetRunSessionMocks(): void {
  updateSessionStoreMock.mockReset();
  updateSessionStoreMock.mockResolvedValue(undefined);
  resolveCronSessionMock.mockReset();
  resolveCronSessionMock.mockReturnValue(makeCronSession());
}

export function resetRunCronIsolatedAgentTurnHarness(): void {
  vi.clearAllMocks();
  resetRunConfigMocks();
  resetRunExecutionMocks();
  resetRunOutcomeMocks();
  resetRunSessionMocks();
  setSessionRuntimeModelMock.mockReturnValue(undefined);
  logWarnMock.mockReset();
}

export function clearFastTestEnv(): string | undefined {
  const previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  delete process.env.OPENCLAW_TEST_FAST;
  return previousFastTestEnv;
}

export function restoreFastTestEnv(previousFastTestEnv: string | undefined): void {
  if (previousFastTestEnv == null) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
}

export async function loadRunCronIsolatedAgentTurn() {
  const { runCronIsolatedAgentTurn } = await import("./run.js");
  return runCronIsolatedAgentTurn;
}
