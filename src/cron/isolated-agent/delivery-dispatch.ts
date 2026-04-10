import { countActiveDescendantRuns } from "../../agents/subagent-registry-read.js";
import { SILENT_REPLY_TOKEN, isSilentReplyText } from "../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../../config/sessions/main-session.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { logError, logWarn } from "../../logger.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { hasScheduledNextRunAtMs } from "../service/jobs.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import { pickSummaryFromOutput } from "./helpers.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

export function matchesMessagingToolDeliveryTarget(
  target: { provider?: string; to?: string; accountId?: string },
  delivery: { channel?: string; to?: string; accountId?: string },
): boolean {
  if (!delivery.channel || !delivery.to || !target.to) {
    return false;
  }
  const channel = normalizeLowercaseStringOrEmpty(delivery.channel);
  const provider = normalizeOptionalLowercaseString(target.provider);
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (target.accountId && delivery.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  // Strip :topic:NNN from message targets and normalize Feishu/Lark prefixes on
  // Both sides so cron duplicate suppression compares canonical IDs.
  const normalizedTargetTo = normalizeDeliveryTarget(channel, target.to.replace(/:topic:\d+$/, ""));
  const normalizedDeliveryTo = normalizeDeliveryTarget(channel, delivery.to);
  return normalizedTargetTo === normalizedDeliveryTo;
}

export function resolveCronDeliveryBestEffort(job: CronJob): boolean {
  return job.delivery?.bestEffort === true;
}

export type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

interface DispatchCronDeliveryParams {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  runSessionId: string;
  runStartedAt: number;
  runEndedAt: number;
  timeoutMs: number;
  resolvedDelivery: DeliveryTargetResolution;
  deliveryRequested: boolean;
  skipHeartbeatDelivery: boolean;
  skipMessagingToolDelivery?: boolean;
  deliveryBestEffort: boolean;
  deliveryPayloadHasStructuredContent: boolean;
  deliveryPayloads: ReplyPayload[];
  synthesizedText?: string;
  summary?: string;
  outputText?: string;
  telemetry?: CronRunTelemetry;
  abortSignal?: AbortSignal;
  isAborted: () => boolean;
  abortReason: () => string;
  withRunSession: (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ) => RunCronAgentTurnResult;
}

export interface DispatchCronDeliveryState {
  result?: RunCronAgentTurnResult;
  delivered: boolean;
  deliveryAttempted: boolean;
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads: ReplyPayload[];
}

const TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

const PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

const STALE_CRON_DELIVERY_MAX_START_DELAY_MS = 3 * 60 * 60_000;

interface CompletedDirectCronDelivery {
  ts: number;
  results: OutboundDeliveryResult[];
}

let gatewayCallRuntimePromise: Promise<typeof import("../../gateway/call.runtime.js")> | undefined;
let deliveryOutboundRuntimePromise:
  | Promise<typeof import("./delivery-outbound.runtime.js")>
  | undefined;
let subagentFollowupRuntimePromise:
  | Promise<typeof import("./subagent-followup.runtime.js")>
  | undefined;

const COMPLETED_DIRECT_CRON_DELIVERIES = new Map<string, CompletedDirectCronDelivery>();

async function loadGatewayCallRuntime(): Promise<typeof import("../../gateway/call.runtime.js")> {
  gatewayCallRuntimePromise ??= import("../../gateway/call.runtime.js");
  return await gatewayCallRuntimePromise;
}

async function loadDeliveryOutboundRuntime(): Promise<
  typeof import("./delivery-outbound.runtime.js")
> {
  deliveryOutboundRuntimePromise ??= import("./delivery-outbound.runtime.js");
  return await deliveryOutboundRuntimePromise;
}

async function loadSubagentFollowupRuntime(): Promise<
  typeof import("./subagent-followup.runtime.js")
> {
  subagentFollowupRuntimePromise ??= import("./subagent-followup.runtime.js");
  return await subagentFollowupRuntimePromise;
}

function cloneDeliveryResults(
  results: readonly OutboundDeliveryResult[],
): OutboundDeliveryResult[] {
  return results.map((result) => ({
    ...result,
    ...(result.meta ? { meta: { ...result.meta } } : {}),
  }));
}

function pruneCompletedDirectCronDeliveries(now: number) {
  const ttlMs = process.env.OPENCLAW_TEST_FAST === "1" ? 60_000 : 24 * 60 * 60 * 1000;
  for (const [key, entry] of COMPLETED_DIRECT_CRON_DELIVERIES) {
    if (now - entry.ts >= ttlMs) {
      COMPLETED_DIRECT_CRON_DELIVERIES.delete(key);
    }
  }
  const maxEntries = 2000;
  if (COMPLETED_DIRECT_CRON_DELIVERIES.size <= maxEntries) {
    return;
  }
  const entries = [...COMPLETED_DIRECT_CRON_DELIVERIES.entries()].toSorted(
    (a, b) => a[1].ts - b[1].ts,
  );
  const toDelete = COMPLETED_DIRECT_CRON_DELIVERIES.size - maxEntries;
  for (let i = 0; i < toDelete; i += 1) {
    const oldest = entries[i];
    if (!oldest) {
      break;
    }
    COMPLETED_DIRECT_CRON_DELIVERIES.delete(oldest[0]);
  }
}

function resolveCronDeliveryScheduledAtMs(params: { job: CronJob; runStartedAt: number }): number {
  const scheduledAt = params.job.state?.nextRunAtMs;
  return hasScheduledNextRunAtMs(scheduledAt) ? scheduledAt : params.runStartedAt;
}

function resolveCronDeliveryStartDelayMs(params: { job: CronJob; runStartedAt: number }): number {
  return params.runStartedAt - resolveCronDeliveryScheduledAtMs(params);
}

function isStaleCronDelivery(params: { job: CronJob; runStartedAt: number }): boolean {
  return resolveCronDeliveryStartDelayMs(params) > STALE_CRON_DELIVERY_MAX_START_DELAY_MS;
}

function rememberCompletedDirectCronDelivery(
  idempotencyKey: string,
  results: readonly OutboundDeliveryResult[],
) {
  const now = Date.now();
  COMPLETED_DIRECT_CRON_DELIVERIES.set(idempotencyKey, {
    results: cloneDeliveryResults(results),
    ts: now,
  });
  pruneCompletedDirectCronDeliveries(now);
}

function getCompletedDirectCronDelivery(
  idempotencyKey: string,
): OutboundDeliveryResult[] | undefined {
  const now = Date.now();
  pruneCompletedDirectCronDeliveries(now);
  const cached = COMPLETED_DIRECT_CRON_DELIVERIES.get(idempotencyKey);
  if (!cached) {
    return undefined;
  }
  return cloneDeliveryResults(cached.results);
}

function buildDirectCronDeliveryIdempotencyKey(params: {
  runSessionId: string;
  delivery: SuccessfulDeliveryTarget;
}): string {
  const threadId =
    params.delivery.threadId == null || params.delivery.threadId === ""
      ? ""
      : String(params.delivery.threadId);
  const accountId = params.delivery.accountId?.trim() ?? "";
  const normalizedTo = normalizeDeliveryTarget(params.delivery.channel, params.delivery.to);
  return `cron-direct-delivery:v1:${params.runSessionId}:${params.delivery.channel}:${accountId}:${normalizedTo}:${threadId}`;
}

function shouldQueueCronAwareness(job: CronJob, deliveryBestEffort: boolean): boolean {
  // Keep issue #52136 scoped to isolated runs. Session-bound cron jobs keep
  // Their existing behavior, and best-effort sends may only partially deliver.
  return job.sessionTarget === "isolated" && !deliveryBestEffort;
}

function resolveCronAwarenessMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string {
  return params.cfg.session?.scope === "global"
    ? resolveMainSessionKey(params.cfg)
    : resolveAgentMainSessionKey({ agentId: params.agentId, cfg: params.cfg });
}

async function queueCronAwarenessSystemEvent(params: {
  cfg: OpenClawConfig;
  jobId: string;
  agentId: string;
  deliveryIdempotencyKey: string;
  outputText?: string;
  synthesizedText?: string;
}): Promise<void> {
  const text =
    normalizeOptionalString(params.outputText) ?? normalizeOptionalString(params.synthesizedText);
  if (!text) {
    return;
  }

  try {
    const { enqueueSystemEvent } = await loadDeliveryOutboundRuntime();
    enqueueSystemEvent(text, {
      contextKey: params.deliveryIdempotencyKey,
      sessionKey: resolveCronAwarenessMainSessionKey({
        agentId: params.agentId,
        cfg: params.cfg,
      }),
    });
  } catch (error) {
    logWarn(
      `[cron:${params.jobId}] failed to queue isolated cron awareness for the main session: ${formatErrorMessage(error)}`,
    );
  }
}

export function resetCompletedDirectCronDeliveriesForTests() {
  COMPLETED_DIRECT_CRON_DELIVERIES.clear();
}

export function getCompletedDirectCronDeliveriesCountForTests(): number {
  return COMPLETED_DIRECT_CRON_DELIVERIES.size;
}

function summarizeDirectCronDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}

function isTransientDirectCronDeliveryError(error: unknown): boolean {
  const message = summarizeDirectCronDeliveryError(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return TRANSIENT_DIRECT_CRON_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

function resolveDirectCronRetryDelaysMs(): readonly number[] {
  return process.env.NODE_ENV === "test" && process.env.OPENCLAW_TEST_FAST === "1"
    ? [8, 16, 32]
    : [5000, 10_000, 20_000];
}

async function retryTransientDirectCronDelivery<T>(params: {
  jobId: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectCronRetryDelaysMs();
  let retryIndex = 0;
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("cron delivery aborted");
    }
    try {
      return await params.run();
    } catch (error) {
      const delayMs = retryDelaysMs[retryIndex];
      if (delayMs == null || !isTransientDirectCronDeliveryError(error) || params.signal?.aborted) {
        throw error;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      logWarn(
        `[cron:${params.jobId}] transient direct announce delivery failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDirectCronDeliveryError(error)}`,
      );
      retryIndex += 1;
      await sleepWithAbort(delayMs, params.signal);
    }
  }
}

export async function dispatchCronDelivery(
  params: DispatchCronDeliveryParams,
): Promise<DispatchCronDeliveryState> {
  const skipMessagingToolDelivery = params.skipMessagingToolDelivery === true;
  let { summary } = params;
  let { outputText } = params;
  let { synthesizedText } = params;
  let { deliveryPayloads } = params;

  // Shared callers can treat a matching message-tool send as the completed
  // Delivery path. Cron-owned callers keep this false so direct cron delivery
  // Remains the only source of delivered state.
  let delivered = skipMessagingToolDelivery;
  let deliveryAttempted = skipMessagingToolDelivery;
  const failDeliveryTarget = (error: string) =>
    params.withRunSession({
      deliveryAttempted,
      error,
      errorKind: "delivery-target",
      outputText,
      status: "error",
      summary,
      ...params.telemetry,
    });
  const cleanupDirectCronSessionIfNeeded = async (): Promise<void> => {
    if (!params.job.deleteAfterRun) {
      return;
    }
    try {
      const { callGateway } = await loadGatewayCallRuntime();
      await callGateway({
        method: "sessions.delete",
        params: {
          deleteTranscript: true,
          emitLifecycleHooks: false,
          key: params.agentSessionKey,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort; direct delivery result should still be returned.
    }
  };
  const finishSilentReplyDelivery = async (): Promise<RunCronAgentTurnResult> => {
    deliveryAttempted = true;
    await cleanupDirectCronSessionIfNeeded();
    return params.withRunSession({
      delivered: false,
      deliveryAttempted: true,
      outputText,
      status: "ok",
      summary,
      ...params.telemetry,
    });
  };

  const deliverViaDirect = async (
    delivery: SuccessfulDeliveryTarget,
    options?: { retryTransient?: boolean },
  ): Promise<RunCronAgentTurnResult | null> => {
    const {
      buildOutboundSessionContext,
      createOutboundSendDeps,
      deliverOutboundPayloads,
      resolveAgentOutboundIdentity,
    } = await loadDeliveryOutboundRuntime();
    const identity = resolveAgentOutboundIdentity(params.cfgWithAgentDefaults, params.agentId);
    const deliveryIdempotencyKey = buildDirectCronDeliveryIdempotencyKey({
      delivery,
      runSessionId: params.runSessionId,
    });
    try {
      const rawPayloads =
        deliveryPayloads.length > 0
          ? deliveryPayloads
          : synthesizedText
            ? [{ text: synthesizedText }]
            : [];
      // Suppress NO_REPLY sentinel so it never leaks to external channels.
      const payloadsForDelivery = rawPayloads.filter(
        (p) => !isSilentReplyText(p.text, SILENT_REPLY_TOKEN),
      );
      if (payloadsForDelivery.length === 0) {
        return await finishSilentReplyDelivery();
      }
      if (params.isAborted()) {
        return params.withRunSession({
          deliveryAttempted,
          error: params.abortReason(),
          status: "error",
          ...params.telemetry,
        });
      }
      if (
        params.deliveryRequested &&
        isStaleCronDelivery({
          job: params.job,
          runStartedAt: params.runStartedAt,
        })
      ) {
        deliveryAttempted = true;
        const nowMs = Date.now();
        const scheduledAtMs = resolveCronDeliveryScheduledAtMs({
          job: params.job,
          runStartedAt: params.runStartedAt,
        });
        const startDelayMs = resolveCronDeliveryStartDelayMs({
          job: params.job,
          runStartedAt: params.runStartedAt,
        });
        logWarn(
          `[cron:${params.job.id}] skipping stale delivery scheduled at ${new Date(scheduledAtMs).toISOString()}, started ${Math.round(startDelayMs / 60_000)}m late, current age ${Math.round((nowMs - scheduledAtMs) / 60_000)}m`,
        );
        return params.withRunSession({
          delivered: false,
          deliveryAttempted,
          outputText,
          status: "ok",
          summary,
          ...params.telemetry,
        });
      }
      deliveryAttempted = true;
      const cachedResults = getCompletedDirectCronDelivery(deliveryIdempotencyKey);
      if (cachedResults) {
        // Cached entries are only recorded after a successful non-empty delivery.
        delivered = true;
        return null;
      }
      const deliverySession = buildOutboundSessionContext({
        agentId: params.agentId,
        cfg: params.cfgWithAgentDefaults,
        sessionKey: params.agentSessionKey,
      });

      // Track bestEffort partial failures so we can log them and avoid
      // Marking the job as delivered when payloads were silently dropped.
      let hadPartialFailure = false;
      const onError = params.deliveryBestEffort
        ? (err: unknown, _payload: unknown) => {
            hadPartialFailure = true;
            logError(
              `[cron:${params.job.id}] delivery payload failed (bestEffort): ${formatErrorMessage(err)}`,
            );
          }
        : undefined;

      const runDelivery = async () =>
        await deliverOutboundPayloads({
          cfg: params.cfgWithAgentDefaults,
          channel: delivery.channel,
          to: delivery.to,
          accountId: delivery.accountId,
          threadId: delivery.threadId,
          payloads: payloadsForDelivery,
          session: deliverySession,
          identity,
          bestEffort: params.deliveryBestEffort,
          deps: createOutboundSendDeps(params.deps),
          abortSignal: params.abortSignal,
          onError,
          // Isolated cron direct delivery uses its own transient retry loop.
          // Keep all attempts out of the write-ahead delivery queue so a
          // Late-successful first send cannot leave behind a failed queue
          // Entry that replays on the next restart.
          // See: https://github.com/openclaw/openclaw/issues/40545
          skipQueue: true,
        });
      const deliveryResults = options?.retryTransient
        ? await retryTransientDirectCronDelivery({
            jobId: params.job.id,
            run: runDelivery,
            signal: params.abortSignal,
          })
        : await runDelivery();
      // Only mark delivered when ALL payloads succeeded (no partial failure).
      delivered = deliveryResults.length > 0 && !hadPartialFailure;
      // Intentionally leave partial success uncached: replay may duplicate the
      // Successful subset, but caching it here would permanently drop the
      // Failed payloads by converting the replay into delivered=true.
      if (delivered && shouldQueueCronAwareness(params.job, params.deliveryBestEffort)) {
        await queueCronAwarenessSystemEvent({
          agentId: params.agentId,
          cfg: params.cfgWithAgentDefaults,
          deliveryIdempotencyKey,
          jobId: params.job.id,
          outputText,
          synthesizedText,
        });
      }
      if (delivered) {
        rememberCompletedDirectCronDelivery(deliveryIdempotencyKey, deliveryResults);
      }
      return null;
    } catch (error) {
      if (!params.deliveryBestEffort) {
        return params.withRunSession({
          deliveryAttempted,
          error: String(error),
          outputText,
          status: "error",
          summary,
          ...params.telemetry,
        });
      }
      logError(
        `[cron:${params.job.id}] delivery failed (bestEffort): ${formatErrorMessage(error)}`,
      );
      return null;
    }
  };

  const finalizeTextDelivery = async (
    delivery: SuccessfulDeliveryTarget,
  ): Promise<RunCronAgentTurnResult | null> => {
    if (!synthesizedText) {
      return null;
    }
    const initialSynthesizedText = synthesizedText.trim();
    let activeSubagentRuns = countActiveDescendantRuns(params.agentSessionKey);
    const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
    const shouldCheckCompletedDescendants =
      activeSubagentRuns === 0 && isLikelyInterimCronMessage(initialSynthesizedText);
    const needsSubagentFollowupRuntime =
      shouldCheckCompletedDescendants || activeSubagentRuns > 0 || expectedSubagentFollowup;
    const subagentFollowupRuntime = needsSubagentFollowupRuntime
      ? await loadSubagentFollowupRuntime()
      : undefined;
    // Also check for already-completed descendants. If the subagent finished
    // Before delivery-dispatch runs, activeSubagentRuns is 0 and
    // ExpectedSubagentFollowup may be false (e.g. cron said "on it" which
    // Doesn't match the narrow hint list). We still need to use the
    // Descendant's output instead of the interim cron text.
    const completedDescendantReply = shouldCheckCompletedDescendants
      ? await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          runStartedAt: params.runStartedAt,
          sessionKey: params.agentSessionKey,
        })
      : undefined;
    const hadDescendants = activeSubagentRuns > 0 || Boolean(completedDescendantReply);
    if (activeSubagentRuns > 0 || expectedSubagentFollowup) {
      let finalReply = await subagentFollowupRuntime?.waitForDescendantSubagentSummary({
        initialReply: initialSynthesizedText,
        observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup,
        sessionKey: params.agentSessionKey,
        timeoutMs: params.timeoutMs,
      });
      activeSubagentRuns = countActiveDescendantRuns(params.agentSessionKey);
      if (!finalReply && activeSubagentRuns === 0) {
        finalReply = await subagentFollowupRuntime?.readDescendantSubagentFallbackReply({
          runStartedAt: params.runStartedAt,
          sessionKey: params.agentSessionKey,
        });
      }
      if (finalReply && activeSubagentRuns === 0) {
        outputText = finalReply;
        summary = pickSummaryFromOutput(finalReply) ?? summary;
        synthesizedText = finalReply;
        deliveryPayloads = [{ text: finalReply }];
      }
    } else if (completedDescendantReply) {
      // Descendants already finished before we got here. Use their output
      // Directly instead of the cron agent's interim text.
      outputText = completedDescendantReply;
      summary = pickSummaryFromOutput(completedDescendantReply) ?? summary;
      synthesizedText = completedDescendantReply;
      deliveryPayloads = [{ text: completedDescendantReply }];
    }
    if (activeSubagentRuns > 0) {
      // Parent orchestration is still in progress; avoid announcing a partial
      // Update to the main requester. Mark deliveryAttempted so the timer does
      // Not fire a redundant enqueueSystemEvent fallback (double-announce bug).
      deliveryAttempted = true;
      return params.withRunSession({
        deliveryAttempted,
        outputText,
        status: "ok",
        summary,
        ...params.telemetry,
      });
    }
    if (
      hadDescendants &&
      synthesizedText.trim() === initialSynthesizedText &&
      isLikelyInterimCronMessage(initialSynthesizedText) &&
      !isSilentReplyText(initialSynthesizedText, SILENT_REPLY_TOKEN)
    ) {
      // Descendants existed but no post-orchestration synthesis arrived AND
      // No descendant fallback reply was available. Suppress stale parent
      // Text like "on it, pulling everything together". Mark deliveryAttempted
      // So the timer does not fire a redundant enqueueSystemEvent fallback.
      deliveryAttempted = true;
      return params.withRunSession({
        deliveryAttempted,
        outputText,
        status: "ok",
        summary,
        ...params.telemetry,
      });
    }
    if (isSilentReplyText(synthesizedText, SILENT_REPLY_TOKEN)) {
      return await finishSilentReplyDelivery();
    }
    if (params.isAborted()) {
      return params.withRunSession({
        deliveryAttempted,
        error: params.abortReason(),
        status: "error",
        ...params.telemetry,
      });
    }
    try {
      return await deliverViaDirect(delivery, { retryTransient: true });
    } finally {
      await cleanupDirectCronSessionIfNeeded();
    }
  };

  if (params.deliveryRequested && !params.skipHeartbeatDelivery && !skipMessagingToolDelivery) {
    if (!params.resolvedDelivery.ok) {
      if (!params.deliveryBestEffort) {
        return {
          delivered,
          deliveryAttempted,
          deliveryPayloads,
          outputText,
          result: failDeliveryTarget(params.resolvedDelivery.error.message),
          summary,
          synthesizedText,
        };
      }
      logWarn(`[cron:${params.job.id}] ${params.resolvedDelivery.error.message}`);
      return {
        delivered,
        deliveryAttempted,
        deliveryPayloads,
        outputText,
        result: params.withRunSession({
          deliveryAttempted,
          outputText,
          status: "ok",
          summary,
          ...params.telemetry,
        }),
        summary,
        synthesizedText,
      };
    }

    // Finalize descendant/subagent output first for text-only cron runs, then
    // Send through the real outbound adapter so delivered=true always reflects
    // An actual channel send instead of internal announce routing.
    const useDirectDelivery =
      params.deliveryPayloadHasStructuredContent || params.resolvedDelivery.threadId != null;
    if (useDirectDelivery) {
      const directResult = await deliverViaDirect(params.resolvedDelivery);
      if (directResult) {
        return {
          delivered,
          deliveryAttempted,
          deliveryPayloads,
          outputText,
          result: directResult,
          summary,
          synthesizedText,
        };
      }
    } else {
      const finalizedTextResult = await finalizeTextDelivery(params.resolvedDelivery);
      if (finalizedTextResult) {
        return {
          delivered,
          deliveryAttempted,
          deliveryPayloads,
          outputText,
          result: finalizedTextResult,
          summary,
          synthesizedText,
        };
      }
    }
  }

  return {
    delivered,
    deliveryAttempted,
    deliveryPayloads,
    outputText,
    summary,
    synthesizedText,
  };
}
