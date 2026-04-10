import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import { ensureAuthProfileStore, loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import {
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "./auth-profiles/usage.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { logModelFallbackDecision } from "./model-fallback-observation.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

const log = createSubsystemLogger("model-fallback");

/**
 * Structured error thrown when all model fallback candidates have been
 * exhausted. Carries per-attempt details so callers can build informative
 * user-facing messages (e.g. "rate-limited, retry in 30 s").
 */
export class FallbackSummaryError extends Error {
  readonly attempts: FallbackAttempt[];
  readonly soonestCooldownExpiry: number | null;

  constructor(
    message: string,
    attempts: FallbackAttempt[],
    soonestCooldownExpiry: number | null,
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = "FallbackSummaryError";
    this.attempts = attempts;
    this.soonestCooldownExpiry = soonestCooldownExpiry;
  }
}

export function isFallbackSummaryError(err: unknown): err is FallbackSummaryError {
  return err instanceof FallbackSummaryError;
}

export interface ModelFallbackRunOptions {
  allowTransientCooldownProbe?: boolean;
}

type ModelFallbackRunFn<T> = (
  provider: string,
  model: string,
  options?: ModelFallbackRunOptions,
) => Promise<T>;

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addExplicitCandidate: (candidate: ModelCandidate) => void;
  addAllowlistedCandidate: (candidate: ModelCandidate) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const addExplicitCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, false);
  };
  const addAllowlistedCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, true);
  };

  return { addAllowlistedCandidate, addExplicitCandidate, candidates };
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

interface ModelFallbackRunResult<T> {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}

function buildFallbackSuccess<T>(params: {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}): ModelFallbackRunResult<T> {
  return {
    attempts: params.attempts,
    model: params.model,
    provider: params.provider,
    result: params.result,
  };
}

async function runFallbackCandidate<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  options?: ModelFallbackRunOptions;
}): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    const result = params.options
      ? await params.run(params.provider, params.model, params.options)
      : await params.run(params.provider, params.model);
    return {
      ok: true,
      result,
    };
  } catch (error) {
    // Normalize abort-wrapped rate-limit errors (e.g. Google Vertex RESOURCE_EXHAUSTED)
    // So they become FailoverErrors and continue the fallback loop instead of aborting.
    const normalizedFailover = coerceToFailoverError(error, {
      model: params.model,
      provider: params.provider,
    });
    if (shouldRethrowAbort(error) && !normalizedFailover) {
      throw error;
    }
    return { error: normalizedFailover ?? error, ok: false };
  }
}

async function runFallbackAttempt<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  options?: ModelFallbackRunOptions;
}): Promise<{ success: ModelFallbackRunResult<T> } | { error: unknown }> {
  const runResult = await runFallbackCandidate({
    model: params.model,
    options: params.options,
    provider: params.provider,
    run: params.run,
  });
  if (runResult.ok) {
    return {
      success: buildFallbackSuccess({
        attempts: params.attempts,
        model: params.model,
        provider: params.provider,
        result: runResult.result,
      }),
    };
  }
  return { error: runResult.error };
}

function sameModelCandidate(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function recordFailedCandidateAttempt(params: {
  attempts: FallbackAttempt[];
  candidate: ModelCandidate;
  error: unknown;
  runId?: string;
  requestedProvider?: string;
  requestedModel?: string;
  attempt: number;
  total: number;
  nextCandidate?: ModelCandidate;
  isPrimary: boolean;
  requestedModelMatched: boolean;
  fallbackConfigured: boolean;
}) {
  const described = describeFailoverError(params.error);
  params.attempts.push({
    code: described.code,
    error: described.message,
    model: params.candidate.model,
    provider: params.candidate.provider,
    reason: described.reason ?? "unknown",
    status: described.status,
  });
  logModelFallbackDecision({
    attempt: params.attempt,
    candidate: params.candidate,
    code: described.code,
    decision: "candidate_failed",
    error: described.message,
    fallbackConfigured: params.fallbackConfigured,
    isPrimary: params.isPrimary,
    nextCandidate: params.nextCandidate,
    reason: described.reason,
    requestedModel: params.requestedModel ?? params.candidate.model,
    requestedModelMatched: params.requestedModelMatched,
    requestedProvider: params.requestedProvider ?? params.candidate.provider,
    runId: params.runId,
    status: described.status,
    total: params.total,
  });
}

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
  soonestCooldownExpiry?: number | null;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  throw new FallbackSummaryError(
    `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`,
    params.attempts,
    params.soonestCooldownExpiry ?? null,
    params.lastError instanceof Error ? params.lastError : undefined,
  );
}

function resolveFallbackSoonestCooldownExpiry(params: {
  authStore: ReturnType<typeof ensureAuthProfileStore> | null;
  agentDir?: string;
  cfg: OpenClawConfig | undefined;
  candidates: ModelCandidate[];
}): number | null {
  if (!params.authStore) {
    return null;
  }

  // Refresh from persisted state because embedded attempts can update auth
  // Cooldowns through a separate store instance while the fallback loop runs.
  const refreshedStore = loadAuthProfileStoreForRuntime(params.agentDir, {
    allowKeychainPrompt: false,
    readOnly: true,
  });
  let soonest: number | null = null;
  for (const candidate of params.candidates) {
    const ids = resolveAuthProfileOrder({
      cfg: params.cfg,
      provider: candidate.provider,
      store: refreshedStore,
    });
    const candidateSoonest = getSoonestCooldownExpiry(refreshedStore, ids, {
      forModel: candidate.model,
    });
    if (
      typeof candidateSoonest === "number" &&
      Number.isFinite(candidateSoonest) &&
      (soonest === null || candidateSoonest < soonest)
    ) {
      soonest = candidateSoonest;
    }
  }

  return soonest;
}

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addExplicitCandidate, addAllowlistedCandidate } =
    createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, opts?: { allowlist?: boolean }) => {
    const resolved = resolveModelRefFromString({
      aliasIndex,
      defaultProvider: params.defaultProvider,
      raw: String(raw ?? ""),
    });
    if (!resolved) {
      return;
    }
    if (opts?.allowlist) {
      addAllowlistedCandidate(resolved.ref);
      return;
    }
    addExplicitCandidate(resolved.ref);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride);
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary);
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);

  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // Model allowlist is present.
    addRaw(raw);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultModel: DEFAULT_MODEL,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = normalizeOptionalString(String(params.provider ?? "")) || defaultProvider;
  const modelRaw = normalizeOptionalString(String(params.model ?? "")) || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const configuredPrimary = normalizeModelRef(defaultProvider, defaultModel);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector(allowlist);

  addExplicitCandidate(normalizedPrimary);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const configuredFallbacks = resolveAgentModelFallbackValues(
      params.cfg?.agents?.defaults?.model,
    );
    // When user runs a different provider than config, only use configured fallbacks
    // If the current model is already in that chain (e.g. session on first fallback).
    if (normalizedPrimary.provider !== configuredPrimary.provider) {
      const isConfiguredFallback = configuredFallbacks.some((raw) => {
        const resolved = resolveModelRefFromString({
          aliasIndex,
          defaultProvider,
          raw: String(raw ?? ""),
        });
        return resolved ? sameModelCandidate(resolved.ref, normalizedPrimary) : false;
      });
      return isConfiguredFallback ? configuredFallbacks : [];
    }
    // Same provider: always use full fallback chain (model version differences within provider).
    return configuredFallbacks;
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      aliasIndex,
      defaultProvider,
      raw: String(raw ?? ""),
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // Model allowlist.
    addExplicitCandidate(resolved.ref);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addExplicitCandidate({ model: primary.model, provider: primary.provider });
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const PROBE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROBE_KEYS = 256;

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = normalizeOptionalString(String(agentDir ?? "")) ?? "";
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function pruneProbeState(now: number): void {
  for (const [key, ts] of lastProbeAttempt) {
    if (!Number.isFinite(ts) || ts <= 0 || now - ts > PROBE_STATE_TTL_MS) {
      lastProbeAttempt.delete(key);
    }
  }
}

function enforceProbeStateCap(): void {
  while (lastProbeAttempt.size > MAX_PROBE_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, ts] of lastProbeAttempt) {
      if (ts < oldestTs) {
        oldestKey = key;
        oldestTs = ts;
      }
    }
    if (!oldestKey) {
      break;
    }
    lastProbeAttempt.delete(oldestKey);
  }
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  pruneProbeState(now);
  const lastProbe = lastProbeAttempt.get(throttleKey) ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

function markProbeAttempt(now: number, throttleKey: string): void {
  pruneProbeState(now);
  lastProbeAttempt.set(throttleKey, now);
  enforceProbeStateCap();
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  throttleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
  model: string;
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  if (!isProbeThrottleOpen(params.now, params.throttleKey)) {
    return false;
  }

  const soonest = getSoonestCooldownExpiry(params.authStore, params.profileIds, {
    forModel: params.model,
    now: params.now,
  });
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
  MAX_PROBE_KEYS,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  PROBE_STATE_TTL_MS,
  isProbeThrottleOpen,
  lastProbeAttempt,
  markProbeAttempt,
  pruneProbeState,
  resolveProbeThrottleKey,
} as const;

type CooldownDecision =
  | {
      type: "skip";
      reason: FailoverReason;
      error: string;
    }
  | {
      type: "attempt";
      reason: FailoverReason;
      markProbe: boolean;
    };

function resolveCooldownDecision(params: {
  candidate: ModelCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  probeThrottleKey: string;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
  profileIds: string[];
}): CooldownDecision {
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    authStore: params.authStore,
    hasFallbackCandidates: params.hasFallbackCandidates,
    isPrimary: params.isPrimary,
    model: params.candidate.model,
    now: params.now,
    profileIds: params.profileIds,
    throttleKey: params.probeThrottleKey,
  });

  const inferredReason =
    resolveProfilesUnavailableReason({
      now: params.now,
      profileIds: params.profileIds,
      store: params.authStore,
    }) ?? "unknown";
  const isPersistentAuthIssue = inferredReason === "auth" || inferredReason === "auth_permanent";
  if (isPersistentAuthIssue) {
    return {
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
      reason: inferredReason,
      type: "skip",
    };
  }

  // Billing is semi-persistent: the user may fix their balance, or a transient
  // 402 might have been misclassified. Probe single-provider setups on the
  // Standard throttle so they can recover without a restart; when fallbacks
  // Exist, only probe near cooldown expiry so the fallback chain stays preferred.
  if (inferredReason === "billing") {
    const shouldProbeSingleProviderBilling =
      params.isPrimary &&
      !params.hasFallbackCandidates &&
      isProbeThrottleOpen(params.now, params.probeThrottleKey);
    if (params.isPrimary && (shouldProbe || shouldProbeSingleProviderBilling)) {
      return { markProbe: true, reason: inferredReason, type: "attempt" };
    }
    return {
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
      reason: inferredReason,
      type: "skip",
    };
  }

  const shouldAttemptDespiteCooldown =
    (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
    (!params.isPrimary && shouldUseTransientCooldownProbeSlot(inferredReason));
  if (!shouldAttemptDespiteCooldown) {
    return {
      error: `Provider ${params.candidate.provider} is in cooldown (all profiles unavailable)`,
      reason: inferredReason,
      type: "skip",
    };
  }

  return {
    markProbe: params.isPrimary && shouldProbe,
    reason: inferredReason,
    type: "attempt",
  };
}

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    fallbacksOverride: params.fallbacksOverride,
    model: params.model,
    provider: params.provider,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  const cooldownProbeUsedProviders = new Set<string>();

  const hasFallbackCandidates = candidates.length > 1;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const isPrimary = i === 0;
    const requestedModel =
      params.provider === candidate.provider && params.model === candidate.model;
    let runOptions: ModelFallbackRunOptions | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        provider: candidate.provider,
        store: authStore,
      });
      const isAnyProfileAvailable = profileIds.some(
        (id) => !isProfileInCooldown(authStore, id, undefined, candidate.model),
      );

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown.
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const decision = resolveCooldownDecision({
          authStore,
          candidate,
          hasFallbackCandidates,
          isPrimary,
          now,
          probeThrottleKey,
          profileIds,
          requestedModel,
        });

        if (decision.type === "skip") {
          attempts.push({
            error: decision.error,
            model: candidate.model,
            provider: candidate.provider,
            reason: decision.reason,
          });
          logModelFallbackDecision({
            attempt: i + 1,
            candidate,
            decision: "skip_candidate",
            error: decision.error,
            fallbackConfigured: hasFallbackCandidates,
            isPrimary,
            nextCandidate: candidates[i + 1],
            profileCount: profileIds.length,
            reason: decision.reason,
            requestedModel: params.model,
            requestedModelMatched: requestedModel,
            requestedProvider: params.provider,
            runId: params.runId,
            total: candidates.length,
          });
          continue;
        }

        if (decision.markProbe) {
          markProbeAttempt(now, probeThrottleKey);
        }
        if (shouldAllowCooldownProbeForReason(decision.reason)) {
          // Probe at most once per provider per fallback run when all profiles
          // Are cooldowned. Re-probing every same-provider candidate can stall
          // Cross-provider fallback on providers with long internal retries.
          const isTransientCooldownReason = shouldUseTransientCooldownProbeSlot(decision.reason);
          if (isTransientCooldownReason && cooldownProbeUsedProviders.has(candidate.provider)) {
            const error = `Provider ${candidate.provider} is in cooldown (probe already attempted this run)`;
            attempts.push({
              error,
              model: candidate.model,
              provider: candidate.provider,
              reason: decision.reason,
            });
            logModelFallbackDecision({
              attempt: i + 1,
              candidate,
              decision: "skip_candidate",
              error,
              fallbackConfigured: hasFallbackCandidates,
              isPrimary,
              nextCandidate: candidates[i + 1],
              profileCount: profileIds.length,
              reason: decision.reason,
              requestedModel: params.model,
              requestedModelMatched: requestedModel,
              requestedProvider: params.provider,
              runId: params.runId,
              total: candidates.length,
            });
            continue;
          }
          runOptions = { allowTransientCooldownProbe: true };
          if (isTransientCooldownReason) {
            transientProbeProviderForAttempt = candidate.provider;
          }
        }
        attemptedDuringCooldown = true;
        logModelFallbackDecision({
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          attempt: i + 1,
          candidate,
          decision: "probe_cooldown_candidate",
          fallbackConfigured: hasFallbackCandidates,
          isPrimary,
          nextCandidate: candidates[i + 1],
          profileCount: profileIds.length,
          reason: decision.reason,
          requestedModel: params.model,
          requestedModelMatched: requestedModel,
          requestedProvider: params.provider,
          runId: params.runId,
          total: candidates.length,
        });
      }
    }

    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      options: runOptions,
    });
    if ("success" in attemptRun) {
      if (i > 0 || attempts.length > 0 || attemptedDuringCooldown) {
        logModelFallbackDecision({
          attempt: i + 1,
          candidate,
          decision: "candidate_succeeded",
          fallbackConfigured: hasFallbackCandidates,
          isPrimary,
          previousAttempts: attempts,
          requestedModel: params.model,
          requestedModelMatched: requestedModel,
          requestedProvider: params.provider,
          runId: params.runId,
          total: candidates.length,
        });
      }
      const notFoundAttempt =
        i > 0 ? attempts.find((a) => a.reason === "model_not_found") : undefined;
      if (notFoundAttempt) {
        log.warn(
          `Model "${sanitizeForLog(notFoundAttempt.provider)}/${sanitizeForLog(notFoundAttempt.model)}" not found. Fell back to "${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}".`,
        );
      }
      return attemptRun.success;
    }
    const err = attemptRun.error;
    {
      if (transientProbeProviderForAttempt) {
        const probeFailureReason = describeFailoverError(err).reason;
        if (!shouldPreserveTransientCooldownProbeSlot(probeFailureReason)) {
          cooldownProbeUsedProviders.add(transientProbeProviderForAttempt);
        }
      }
      // Context overflow errors should be handled by the inner runner's
      // Compaction/retry logic, not by model fallback.  If one escapes as a
      // Throw, rethrow it immediately rather than trying a different model
      // That may have a smaller context window and fail worse.
      const errMessage = formatErrorMessage(err);
      if (isLikelyContextOverflowError(errMessage)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          model: candidate.model,
          provider: candidate.provider,
        }) ?? err;

      // LiveSessionModelSwitchError during fallback means the session's
      // Persisted model conflicts with this fallback candidate.  Treat it
      // As a known failover so the chain continues to the next candidate
      // Instead of re-throwing and triggering infinite retry loops in the
      // Outer runner.  (#58466)
      if (err instanceof LiveSessionModelSwitchError) {
        const switchMsg = err.message;
        const switchNormalized = new FailoverError(switchMsg, {
          model: candidate.model,
          provider: candidate.provider,
          reason: "overloaded",
        });
        lastError = switchNormalized;
        recordFailedCandidateAttempt({
          attempt: i + 1,
          attempts,
          candidate,
          error: switchNormalized,
          fallbackConfigured: hasFallbackCandidates,
          isPrimary,
          nextCandidate: candidates[i + 1],
          requestedModel: params.model,
          requestedModelMatched: requestedModel,
          requestedProvider: params.provider,
          runId: params.runId,
          total: candidates.length,
        });
        continue;
      }

      // Even unrecognized errors should not abort the fallback loop when
      // There are remaining candidates.  Only abort/context-overflow errors
      // (handled above) are truly non-retryable.
      const isKnownFailover = isFailoverError(normalized);
      if (!isKnownFailover && i === candidates.length - 1) {
        throw err;
      }

      lastError = isKnownFailover ? normalized : err;
      recordFailedCandidateAttempt({
        attempt: i + 1,
        attempts,
        candidate,
        error: normalized,
        fallbackConfigured: hasFallbackCandidates,
        isPrimary,
        nextCandidate: candidates[i + 1],
        requestedModel: params.model,
        requestedModelMatched: requestedModel,
        requestedProvider: params.provider,
        runId: params.runId,
        total: candidates.length,
      });
      await params.onError?.({
        attempt: i + 1,
        error: isKnownFailover ? normalized : err,
        model: candidate.model,
        provider: candidate.provider,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
    label: "models",
    lastError,
    soonestCooldownExpiry: resolveFallbackSoonestCooldownExpiry({
      agentDir: params.agentDir,
      authStore,
      candidates,
      cfg: params.cfg,
    }),
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const attemptRun = await runFallbackAttempt({ run: params.run, ...candidate, attempts });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    {
      const err = attemptRun.error;
      lastError = err;
      attempts.push({
        error: formatErrorMessage(err),
        model: candidate.model,
        provider: candidate.provider,
      });
      await params.onError?.({
        attempt: i + 1,
        error: err,
        model: candidate.model,
        provider: candidate.provider,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
    label: "image models",
    lastError,
  });
}
