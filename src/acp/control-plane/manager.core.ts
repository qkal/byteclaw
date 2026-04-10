import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  startTaskRunByRunId,
} from "../../tasks/task-executor.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import {
  createIdentityFromEnsure,
  identityEquals,
  identityHasStableSessionId,
  isSessionIdentityPending,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "../runtime/session-identity.js";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeSessionMode,
  AcpRuntimeStatus,
} from "../runtime/types.js";
import { reconcileManagerRuntimeSessionIdentifiers } from "./manager.identity-reconcile.js";
import {
  applyManagerRuntimeControls,
  resolveManagerRuntimeCapabilities,
} from "./manager.runtime-controls.js";
import {
  type AcpCloseSessionInput,
  type AcpCloseSessionResult,
  type AcpInitializeSessionInput,
  type AcpManagerObservabilitySnapshot,
  type AcpRunTurnInput,
  type AcpSessionManagerDeps,
  type AcpSessionResolution,
  type AcpSessionRuntimeOptions,
  type AcpSessionStatus,
  type AcpStartupIdentityReconcileResult,
  type ActiveTurnState,
  DEFAULT_DEPS,
  type SessionAcpMeta,
  type SessionEntry,
  type TurnLatencyStats,
} from "./manager.types.js";
import {
  canonicalizeAcpSessionKey,
  createUnsupportedControlError,
  hasLegacyAcpIdentityProjection,
  normalizeAcpErrorCode,
  normalizeActorKey,
  requireReadySessionMeta,
  resolveAcpAgentFromSessionKey,
  resolveAcpSessionResolutionError,
  resolveMissingMetaError,
  resolveRuntimeIdleTtlMs,
} from "./manager.utils.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
import { RuntimeCache } from "./runtime-cache.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
  runtimeOptionsEqual,
  validateRuntimeConfigOptionInput,
  validateRuntimeModeInput,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";
import { SessionActorQueue } from "./session-actor-queue.js";

const ACP_TURN_TIMEOUT_GRACE_MS = 1000;
const ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS = 2000;
const ACP_TURN_TIMEOUT_REASON = "turn-timeout";
const ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH = 160;
const ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH = 240;

function summarizeBackgroundTaskText(text: string): string {
  const normalized = normalizeText(text) ?? "ACP background task";
  if (normalized.length <= ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, ACP_BACKGROUND_TASK_TEXT_MAX_LENGTH - 1)}…`;
}

function appendBackgroundTaskProgressSummary(current: string, chunk: string): string {
  const normalizedChunk = normalizeText(chunk)?.replace(/\s+/g, " ");
  if (!normalizedChunk) {
    return current;
  }
  const combined = current ? `${current} ${normalizedChunk}` : normalizedChunk;
  if (combined.length <= ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH) {
    return combined;
  }
  return `${combined.slice(0, ACP_BACKGROUND_TASK_PROGRESS_MAX_LENGTH - 1)}…`;
}

function resolveBackgroundTaskFailureStatus(error: AcpRuntimeError): "failed" | "timed_out" {
  return /\btimed out\b/i.test(error.message) ? "timed_out" : "failed";
}

function resolveBackgroundTaskTerminalResult(progressSummary: string): {
  terminalOutcome?: "blocked";
  terminalSummary?: string;
} {
  const normalized = normalizeText(progressSummary)?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return {};
  }
  const permissionDeniedMatch = normalized.match(
    /\b(?:write failed:\s*)?permission denied(?: for (?<path>\S+))?\.?/i,
  );
  if (permissionDeniedMatch) {
    const path = normalizeText(permissionDeniedMatch.groups?.path)?.replace(/[.,;:!?]+$/, "");
    return {
      terminalOutcome: "blocked",
      terminalSummary: path ? `Permission denied for ${path}.` : "Permission denied.",
    };
  }
  if (
    /\bneed a writable session\b/i.test(normalized) ||
    /\bfilesystem authorization\b/i.test(normalized) ||
    /`?apply_patch`?/i.test(normalized)
  ) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Writable session or apply_patch authorization required.",
    };
  }
  return {};
}

interface BackgroundTaskContext {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  runId: string;
  label?: string;
  task: string;
}

export class AcpSessionManager {
  private readonly actorQueue = new SessionActorQueue();
  private readonly actorTailBySession = this.actorQueue.getTailMapForTesting();
  private readonly runtimeCache = new RuntimeCache();
  private readonly activeTurnBySession = new Map<string, ActiveTurnState>();
  private readonly turnLatencyStats: TurnLatencyStats = {
    completed: 0,
    failed: 0,
    maxMs: 0,
    totalMs: 0,
  };
  private readonly errorCountsByCode = new Map<string, number>();
  private evictedRuntimeCount = 0;
  private lastEvictedAt: number | undefined;

  constructor(private readonly deps: AcpSessionManagerDeps = DEFAULT_DEPS) {}

  resolveSession(params: { cfg: OpenClawConfig; sessionKey: string }): AcpSessionResolution {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      return {
        kind: "none",
        sessionKey,
      };
    }
    const acp = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey,
    })?.acp;
    if (acp) {
      return {
        kind: "ready",
        meta: acp,
        sessionKey,
      };
    }
    if (isAcpSessionKey(sessionKey)) {
      return {
        error: resolveMissingMetaError(sessionKey),
        kind: "stale",
        sessionKey,
      };
    }
    return {
      kind: "none",
      sessionKey,
    };
  }

  getObservabilitySnapshot(cfg: OpenClawConfig): AcpManagerObservabilitySnapshot {
    const completedTurns = this.turnLatencyStats.completed + this.turnLatencyStats.failed;
    const averageLatencyMs =
      completedTurns > 0 ? Math.round(this.turnLatencyStats.totalMs / completedTurns) : 0;
    return {
      errorsByCode: Object.fromEntries(
        [...this.errorCountsByCode.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
      ),
      runtimeCache: {
        activeSessions: this.runtimeCache.size(),
        evictedTotal: this.evictedRuntimeCount,
        idleTtlMs: resolveRuntimeIdleTtlMs(cfg),
        ...(this.lastEvictedAt ? { lastEvictedAt: this.lastEvictedAt } : {}),
      },
      turns: {
        active: this.activeTurnBySession.size,
        averageLatencyMs,
        completed: this.turnLatencyStats.completed,
        failed: this.turnLatencyStats.failed,
        maxLatencyMs: this.turnLatencyStats.maxMs,
        queueDepth: this.actorQueue.getTotalPendingCount(),
      },
    };
  }

  async reconcilePendingSessionIdentities(params: {
    cfg: OpenClawConfig;
  }): Promise<AcpStartupIdentityReconcileResult> {
    let checked = 0;
    let resolved = 0;
    let failed = 0;

    let acpSessions: Awaited<ReturnType<AcpSessionManagerDeps["listAcpSessions"]>>;
    try {
      acpSessions = await this.deps.listAcpSessions({
        cfg: params.cfg,
      });
    } catch (error) {
      logVerbose(`acp-manager: startup identity scan failed: ${String(error)}`);
      return { checked, failed: failed + 1, resolved };
    }

    for (const session of acpSessions) {
      if (!session.acp || !session.sessionKey) {
        continue;
      }
      const currentIdentity = resolveSessionIdentityFromMeta(session.acp);
      if (
        !isSessionIdentityPending(currentIdentity) ||
        !identityHasStableSessionId(currentIdentity)
      ) {
        continue;
      }

      checked += 1;
      try {
        const becameResolved = await this.withSessionActor(session.sessionKey, async () => {
          const resolution = this.resolveSession({
            cfg: params.cfg,
            sessionKey: session.sessionKey,
          });
          if (resolution.kind !== "ready") {
            return false;
          }
          const { runtime, handle, meta } = await this.ensureRuntimeHandle({
            cfg: params.cfg,
            meta: resolution.meta,
            sessionKey: session.sessionKey,
          });
          const reconciled = await this.reconcileRuntimeSessionIdentifiers({
            cfg: params.cfg,
            failOnStatusError: false,
            handle,
            meta,
            runtime,
            sessionKey: session.sessionKey,
          });
          return !isSessionIdentityPending(resolveSessionIdentityFromMeta(reconciled.meta));
        });
        if (becameResolved) {
          resolved += 1;
        }
      } catch (error) {
        failed += 1;
        logVerbose(
          `acp-manager: startup identity reconcile failed for ${session.sessionKey}: ${String(error)}`,
        );
      }
    }

    return { checked, failed, resolved };
  }

  async initializeSession(input: AcpInitializeSessionInput): Promise<{
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const agent = normalizeAgentId(input.agent);
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const backend = this.deps.requireRuntimeBackend(input.backendId || input.cfg.acp?.backend);
      const { runtime } = backend;
      const initialRuntimeOptions = validateRuntimeOptionPatch({ cwd: input.cwd });
      const requestedCwd = initialRuntimeOptions.cwd;
      this.enforceConcurrentSessionLimit({
        cfg: input.cfg,
        sessionKey,
      });
      const handle = await withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
        run: async () =>
          await runtime.ensureSession({
            agent,
            cwd: requestedCwd,
            mode: input.mode,
            resumeSessionId: input.resumeSessionId,
            sessionKey,
          }),
      });
      const effectiveCwd = normalizeText(handle.cwd) ?? requestedCwd;
      const effectiveRuntimeOptions = normalizeRuntimeOptions({
        ...initialRuntimeOptions,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      });

      const identityNow = Date.now();
      const initializedIdentity =
        mergeSessionIdentity({
          current: undefined,
          incoming: createIdentityFromEnsure({
            handle,
            now: identityNow,
          }),
          now: identityNow,
        }) ??
        ({
          lastUpdatedAt: identityNow,
          source: "ensure",
          state: "pending",
        } as const);
      const meta: SessionAcpMeta = {
        backend: handle.backend || backend.id,
        agent,
        runtimeSessionName: handle.runtimeSessionName,
        identity: initializedIdentity,
        mode: input.mode,
        ...(Object.keys(effectiveRuntimeOptions).length > 0
          ? { runtimeOptions: effectiveRuntimeOptions }
          : {}),
        cwd: effectiveCwd,
        state: "idle",
        lastActivityAt: Date.now(),
      };

      let persisted: SessionEntry | null = null;
      try {
        persisted = await this.writeSessionMeta({
          cfg: input.cfg,
          failOnError: true,
          mutate: () => meta,
          sessionKey,
        });
      } catch (error) {
        await runtime
          .close({
            handle,
            reason: "init-meta-failed",
          })
          .catch((closeError) => {
            logVerbose(
              `acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`,
            );
          });
        throw error;
      }

      if (!persisted?.acp) {
        await runtime
          .close({
            handle,
            reason: "init-meta-failed",
          })
          .catch((closeError) => {
            logVerbose(
              `acp-manager: cleanup close failed after metadata write error for ${sessionKey}: ${String(closeError)}`,
            );
          });

        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `Could not persist ACP metadata for ${sessionKey}.`,
        );
      }
      this.setCachedRuntimeState(sessionKey, {
        agent,
        backend: handle.backend || backend.id,
        cwd: effectiveCwd,
        handle,
        mode: input.mode,
        runtime,
      });
      return {
        handle,
        meta,
        runtime,
      };
    });
  }

  async getSessionStatus(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    signal?: AbortSignal;
  }): Promise<AcpSessionStatus> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    this.throwIfAborted(params.signal);
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(
      sessionKey,
      async () => {
        this.throwIfAborted(params.signal);
        const resolution = this.resolveSession({
          cfg: params.cfg,
          sessionKey,
        });
        const resolvedMeta = requireReadySessionMeta(resolution);
        const {
          runtime,
          handle: ensuredHandle,
          meta: ensuredMeta,
        } = await this.ensureRuntimeHandle({
          cfg: params.cfg,
          meta: resolvedMeta,
          sessionKey,
        });
        let handle = ensuredHandle;
        let meta = ensuredMeta;
        const capabilities = await this.resolveRuntimeCapabilities({ handle, runtime });
        let runtimeStatus: AcpRuntimeStatus | undefined;
        if (runtime.getStatus) {
          runtimeStatus = await withAcpRuntimeErrorBoundary({
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "Could not read ACP runtime status.",
            run: async () => {
              this.throwIfAborted(params.signal);
              const status = await runtime.getStatus!({
                handle,
                ...(params.signal ? { signal: params.signal } : {}),
              });
              this.throwIfAborted(params.signal);
              return status;
            },
          });
        }
        ({ handle, meta, runtimeStatus } = await this.reconcileRuntimeSessionIdentifiers({
          cfg: params.cfg,
          failOnStatusError: true,
          handle,
          meta,
          runtime,
          runtimeStatus,
          sessionKey,
        }));
        const identity = resolveSessionIdentityFromMeta(meta);
        return {
          sessionKey,
          backend: handle.backend || meta.backend,
          agent: meta.agent,
          ...(identity ? { identity } : {}),
          state: meta.state,
          mode: meta.mode,
          runtimeOptions: resolveRuntimeOptionsFromMeta(meta),
          capabilities,
          runtimeStatus,
          lastActivityAt: meta.lastActivityAt,
          lastError: meta.lastError,
        };
      },
      params.signal,
    );
  }

  async setSessionRuntimeMode(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtimeMode: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const runtimeMode = validateRuntimeModeInput(params.runtimeMode);

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        meta: resolvedMeta,
        sessionKey,
      });
      const capabilities = await this.resolveRuntimeCapabilities({ handle, runtime });
      if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
        throw createUnsupportedControlError({
          backend: handle.backend || meta.backend,
          control: "session/set_mode",
        });
      }

      await withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime mode.",
        run: async () =>
          await runtime.setMode!({
            handle,
            mode: runtimeMode,
          }),
      });

      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(meta),
        patch: { runtimeMode },
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        options: nextOptions,
        sessionKey,
      });
      return nextOptions;
    });
  }

  async setSessionConfigOption(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    key: string;
    value: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    const normalizedOption = validateRuntimeConfigOptionInput(params.key, params.value);
    const { key } = normalizedOption;
    const { value } = normalizedOption;

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle, meta } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        meta: resolvedMeta,
        sessionKey,
      });
      const inferredPatch = inferRuntimeOptionPatchFromConfigOption(key, value);
      const capabilities = await this.resolveRuntimeCapabilities({ handle, runtime });
      if (
        !capabilities.controls.includes("session/set_config_option") ||
        !runtime.setConfigOption
      ) {
        throw createUnsupportedControlError({
          backend: handle.backend || meta.backend,
          control: "session/set_config_option",
        });
      }

      const advertisedKeys = new Set(
        (capabilities.configOptionKeys ?? [])
          .map((entry) => normalizeText(entry))
          .filter(Boolean) as string[],
      );
      if (advertisedKeys.size > 0 && !advertisedKeys.has(key)) {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNSUPPORTED_CONTROL",
          `ACP backend "${handle.backend || meta.backend}" does not accept config key "${key}".`,
        );
      }

      await withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime config option.",
        run: async () =>
          await runtime.setConfigOption!({
            handle,
            key,
            value,
          }),
      });

      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(meta),
        patch: inferredPatch,
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        options: nextOptions,
        sessionKey,
      });
      return nextOptions;
    });
  }

  async updateSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    patch: Partial<AcpSessionRuntimeOptions>;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    const validatedPatch = validateRuntimeOptionPatch(params.patch);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }

    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const nextOptions = mergeRuntimeOptions({
        current: resolveRuntimeOptionsFromMeta(resolvedMeta),
        patch: validatedPatch,
      });
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        options: nextOptions,
        sessionKey,
      });
      return nextOptions;
    });
  }

  async resetSessionRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<AcpSessionRuntimeOptions> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        meta: resolvedMeta,
        sessionKey,
      });
      await withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not reset ACP runtime options.",
        run: async () =>
          await runtime.close({
            handle,
            reason: "reset-runtime-options",
          }),
      });
      this.clearCachedRuntimeState(sessionKey);
      await this.persistRuntimeOptions({
        cfg: params.cfg,
        options: {},
        sessionKey,
      });
      return {};
    });
  }

  async runTurn(input: AcpRunTurnInput): Promise<void> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    await this.withSessionActor(
      sessionKey,
      async () => {
        const turnStartedAt = Date.now();
        const actorKey = normalizeActorKey(sessionKey);
        const taskContext =
          input.mode === "prompt"
            ? this.resolveBackgroundTaskContext({
                cfg: input.cfg,
                requestId: input.requestId,
                sessionKey,
                text: input.text,
              })
            : null;
        if (taskContext) {
          this.createBackgroundTaskRecord(taskContext, turnStartedAt);
        }
        let taskProgressSummary = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const resolution = this.resolveSession({
            cfg: input.cfg,
            sessionKey,
          });
          const resolvedMeta = requireReadySessionMeta(resolution);
          let runtime: AcpRuntime | undefined;
          let handle: AcpRuntimeHandle | undefined;
          let meta: SessionAcpMeta | undefined;
          let activeTurn: ActiveTurnState | undefined;
          let internalAbortController: AbortController | undefined;
          let onCallerAbort: (() => void) | undefined;
          let activeTurnStarted = false;
          let sawTurnOutput = false;
          let retryFreshHandle = false;
          let skipPostTurnCleanup = false;
          try {
            const ensured = await this.ensureRuntimeHandle({
              cfg: input.cfg,
              meta: resolvedMeta,
              sessionKey,
            });
            ({ runtime } = ensured);
            ({ handle } = ensured);
            ({ meta } = ensured);
            await this.applyRuntimeControls({
              handle,
              meta,
              runtime,
              sessionKey,
            });

            await this.setSessionState({
              cfg: input.cfg,
              clearLastError: true,
              sessionKey,
              state: "running",
            });

            internalAbortController = new AbortController();
            onCallerAbort = () => {
              internalAbortController?.abort();
            };
            if (input.signal?.aborted) {
              internalAbortController.abort();
            } else if (input.signal) {
              input.signal.addEventListener("abort", onCallerAbort, { once: true });
            }

            activeTurn = {
              abortController: internalAbortController,
              handle,
              runtime,
            };
            this.activeTurnBySession.set(actorKey, activeTurn);
            activeTurnStarted = true;

            let streamError: AcpRuntimeError | null = null;
            const combinedSignal =
              input.signal && typeof AbortSignal.any === "function"
                ? AbortSignal.any([input.signal, internalAbortController.signal])
                : internalAbortController.signal;
            const eventGate = { open: true };
            const turnPromise = (async () => {
              for await (const event of runtime.runTurn({
                attachments: input.attachments,
                handle,
                mode: input.mode,
                requestId: input.requestId,
                signal: combinedSignal,
                text: input.text,
              })) {
                if (!eventGate.open) {
                  continue;
                }
                if (event.type === "error") {
                  streamError = new AcpRuntimeError(
                    normalizeAcpErrorCode(event.code),
                    normalizeText(event.message) || "ACP turn failed before completion.",
                  );
                } else if (event.type === "text_delta" || event.type === "tool_call") {
                  sawTurnOutput = true;
                  if (event.type === "text_delta" && event.stream !== "thought" && event.text) {
                    taskProgressSummary = appendBackgroundTaskProgressSummary(
                      taskProgressSummary,
                      event.text,
                    );
                  }
                  if (taskContext) {
                    this.markBackgroundTaskRunning(taskContext.runId, {
                      lastEventAt: Date.now(),
                      progressSummary: taskProgressSummary || null,
                      sessionKey,
                    });
                  }
                }
                if (input.onEvent) {
                  await input.onEvent(event);
                }
              }
              if (eventGate.open && streamError) {
                throw streamError;
              }
            })();
            const turnTimeoutMs = this.resolveTurnTimeoutMs({
              cfg: input.cfg,
              meta,
            });
            const sessionMode = meta.mode;
            await this.awaitTurnWithTimeout({
              onTimeout: async () => {
                eventGate.open = false;
                skipPostTurnCleanup = true;
                if (!activeTurn) {
                  return;
                }
                await this.cleanupTimedOutTurn({
                  activeTurn,
                  mode: sessionMode,
                  sessionKey,
                });
              },
              sessionKey,
              timeoutLabelMs: turnTimeoutMs,
              timeoutMs: turnTimeoutMs + ACP_TURN_TIMEOUT_GRACE_MS,
              turnPromise,
            });
            if (streamError) {
              throw streamError;
            }
            this.recordTurnCompletion({
              startedAt: turnStartedAt,
            });
            if (taskContext) {
              const terminalResult = resolveBackgroundTaskTerminalResult(taskProgressSummary);
              this.markBackgroundTaskTerminal(taskContext.runId, {
                endedAt: Date.now(),
                error: undefined,
                lastEventAt: Date.now(),
                progressSummary: taskProgressSummary || null,
                sessionKey,
                status: "succeeded",
                terminalOutcome: terminalResult.terminalOutcome,
                terminalSummary: terminalResult.terminalSummary ?? null,
              });
            }
            await this.setSessionState({
              cfg: input.cfg,
              clearLastError: true,
              sessionKey,
              state: "idle",
            });
            return;
          } catch (error) {
            const acpError = toAcpRuntimeError({
              error,
              fallbackCode: activeTurnStarted ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
              fallbackMessage: activeTurnStarted
                ? "ACP turn failed before completion."
                : "Could not initialize ACP session runtime.",
            });
            retryFreshHandle = await this.prepareFreshHandleRetry({
              attempt,
              cfg: input.cfg,
              error: acpError,
              meta,
              runtime,
              sawTurnOutput,
              sessionKey,
            });
            if (retryFreshHandle) {
              continue;
            }
            this.recordTurnCompletion({
              errorCode: acpError.code,
              startedAt: turnStartedAt,
            });
            if (taskContext) {
              this.markBackgroundTaskTerminal(taskContext.runId, {
                endedAt: Date.now(),
                error: acpError.message,
                lastEventAt: Date.now(),
                progressSummary: taskProgressSummary || null,
                sessionKey,
                status: resolveBackgroundTaskFailureStatus(acpError),
                terminalSummary: null,
              });
            }
            await this.setSessionState({
              cfg: input.cfg,
              lastError: acpError.message,
              sessionKey,
              state: "error",
            });
            throw acpError;
          } finally {
            if (input.signal && onCallerAbort) {
              input.signal.removeEventListener("abort", onCallerAbort);
            }
            if (activeTurn && this.activeTurnBySession.get(actorKey) === activeTurn) {
              this.activeTurnBySession.delete(actorKey);
            }
            if (
              !retryFreshHandle &&
              !skipPostTurnCleanup &&
              runtime &&
              handle &&
              meta &&
              meta.mode !== "oneshot"
            ) {
              ({ handle } = await this.reconcileRuntimeSessionIdentifiers({
                cfg: input.cfg,
                failOnStatusError: false,
                handle,
                meta,
                runtime,
                sessionKey,
              }));
            }
            if (
              !retryFreshHandle &&
              !skipPostTurnCleanup &&
              runtime &&
              handle &&
              meta &&
              meta.mode === "oneshot"
            ) {
              try {
                await runtime.close({
                  handle,
                  reason: "oneshot-complete",
                });
              } catch (error) {
                logVerbose(
                  `acp-manager: ACP oneshot close failed for ${sessionKey}: ${String(error)}`,
                );
              } finally {
                this.clearCachedRuntimeState(sessionKey);
              }
            }
          }
          if (retryFreshHandle) {
            continue;
          }
        }
      },
      input.signal,
    );
  }

  private resolveTurnTimeoutMs(params: { cfg: OpenClawConfig; meta: SessionAcpMeta }): number {
    const runtimeTimeoutSeconds = resolveRuntimeOptionsFromMeta(params.meta).timeoutSeconds;
    if (
      typeof runtimeTimeoutSeconds === "number" &&
      Number.isFinite(runtimeTimeoutSeconds) &&
      runtimeTimeoutSeconds > 0
    ) {
      return Math.max(1000, Math.round(runtimeTimeoutSeconds * 1000));
    }
    return resolveAgentTimeoutMs({
      cfg: params.cfg,
      minMs: 1000,
    });
  }

  private async awaitTurnWithTimeout<T>(params: {
    sessionKey: string;
    turnPromise: Promise<T>;
    timeoutMs: number;
    timeoutLabelMs: number;
    onTimeout: () => Promise<void>;
  }): Promise<T> {
    const observedTurnPromise: Promise<
      | {
          kind: "value";
          value: T;
        }
      | {
          kind: "error";
          error: unknown;
        }
    > = params.turnPromise.then(
      (value) => ({
        kind: "value" as const,
        value,
      }),
      (error) => ({
        error,
        kind: "error" as const,
      }),
    );

    if (params.timeoutMs <= 0) {
      const outcome = await observedTurnPromise;
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      return outcome.value;
    }

    const timeoutToken = Symbol("acp-turn-timeout");
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
      timer = setTimeout(() => resolve(timeoutToken), params.timeoutMs);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([observedTurnPromise, timeoutPromise]);
      if (outcome === timeoutToken) {
        void observedTurnPromise.then((lateOutcome) => {
          if (lateOutcome.kind === "error") {
            logVerbose(
              `acp-manager: detached late turn error after timeout for ${params.sessionKey}: ${String(lateOutcome.error)}`,
            );
          }
        });
        await params.onTimeout();
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `ACP turn timed out after ${Math.max(1, Math.round(params.timeoutLabelMs / 1000))}s.`,
        );
      }
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async cleanupTimedOutTurn(params: {
    sessionKey: string;
    activeTurn: ActiveTurnState;
    mode: AcpRuntimeSessionMode;
  }): Promise<void> {
    params.activeTurn.abortController.abort();
    if (!params.activeTurn.cancelPromise) {
      params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
        handle: params.activeTurn.handle,
        reason: ACP_TURN_TIMEOUT_REASON,
      });
    }
    const cancelFinished = await this.awaitCleanupWithGrace({
      label: "cancel",
      promise: params.activeTurn.cancelPromise,
      sessionKey: params.sessionKey,
    });
    if (params.mode !== "oneshot") {
      return;
    }
    const closePromise = params.activeTurn.runtime.close({
      handle: params.activeTurn.handle,
      reason: ACP_TURN_TIMEOUT_REASON,
    });
    const closeFinished = await this.awaitCleanupWithGrace({
      label: "close",
      promise: closePromise,
      sessionKey: params.sessionKey,
    });
    if (cancelFinished && closeFinished) {
      this.clearCachedRuntimeStateIfHandleMatches({
        handle: params.activeTurn.handle,
        sessionKey: params.sessionKey,
      });
      return;
    }
    void Promise.allSettled([params.activeTurn.cancelPromise, closePromise]).then(() => {
      this.clearCachedRuntimeStateIfHandleMatches({
        handle: params.activeTurn.handle,
        sessionKey: params.sessionKey,
      });
    });
  }

  private async awaitCleanupWithGrace(params: {
    sessionKey: string;
    label: "cancel" | "close";
    promise: Promise<unknown>;
  }): Promise<boolean> {
    const observedCleanupPromise: Promise<
      | {
          kind: "done";
        }
      | {
          kind: "error";
          error: unknown;
        }
    > = params.promise.then(
      () => ({
        kind: "done" as const,
      }),
      (error) => ({
        error,
        kind: "error" as const,
      }),
    );
    const timeoutToken = Symbol(`acp-timeout-${params.label}`);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
      timer = setTimeout(() => resolve(timeoutToken), ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS);
      timer.unref?.();
    });

    try {
      const outcome = await Promise.race([observedCleanupPromise, timeoutPromise]);
      if (outcome === timeoutToken) {
        void observedCleanupPromise.then((lateOutcome) => {
          if (lateOutcome.kind === "error") {
            logVerbose(
              `acp-manager: detached timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(lateOutcome.error)}`,
            );
          }
        });
        logVerbose(
          `acp-manager: timed-out turn ${params.label} cleanup exceeded ${ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS}ms for ${params.sessionKey}`,
        );
        return false;
      }
      if (outcome.kind === "error") {
        logVerbose(
          `acp-manager: timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(outcome.error)}`,
        );
      }
      return true;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async cancelSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason?: string;
  }): Promise<void> {
    const sessionKey = canonicalizeAcpSessionKey(params);
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: params.cfg });
    const actorKey = normalizeActorKey(sessionKey);
    const activeTurn = this.activeTurnBySession.get(actorKey);
    if (activeTurn) {
      activeTurn.abortController.abort();
      if (!activeTurn.cancelPromise) {
        activeTurn.cancelPromise = activeTurn.runtime.cancel({
          handle: activeTurn.handle,
          reason: params.reason,
        });
      }
      await withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP cancel failed before completion.",
        run: async () => await activeTurn.cancelPromise!,
      });
      return;
    }

    await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: params.cfg,
        sessionKey,
      });
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { runtime, handle } = await this.ensureRuntimeHandle({
        cfg: params.cfg,
        meta: resolvedMeta,
        sessionKey,
      });
      try {
        await withAcpRuntimeErrorBoundary({
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP cancel failed before completion.",
          run: async () =>
            await runtime.cancel({
              handle,
              reason: params.reason,
            }),
        });
        await this.setSessionState({
          cfg: params.cfg,
          clearLastError: true,
          sessionKey,
          state: "idle",
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP cancel failed before completion.",
        });
        await this.setSessionState({
          cfg: params.cfg,
          lastError: acpError.message,
          sessionKey,
          state: "error",
        });
        throw acpError;
      }
    });
  }

  async closeSession(input: AcpCloseSessionInput): Promise<AcpCloseSessionResult> {
    const sessionKey = canonicalizeAcpSessionKey({
      cfg: input.cfg,
      sessionKey: input.sessionKey,
    });
    if (!sessionKey) {
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
    }
    await this.evictIdleRuntimeHandles({ cfg: input.cfg });
    return await this.withSessionActor(sessionKey, async () => {
      const resolution = this.resolveSession({
        cfg: input.cfg,
        sessionKey,
      });
      const resolutionError = resolveAcpSessionResolutionError(resolution);
      if (resolutionError) {
        if (input.requireAcpSession ?? true) {
          throw resolutionError;
        }
        return {
          metaCleared: false,
          runtimeClosed: false,
        };
      }
      const meta = requireReadySessionMeta(resolution);
      const currentIdentity = resolveSessionIdentityFromMeta(meta);
      const shouldSkipRuntimeClose =
        input.discardPersistentState &&
        currentIdentity != null &&
        !identityHasStableSessionId(currentIdentity);

      let runtimeClosed = false;
      let runtimeNotice: string | undefined;
      if (shouldSkipRuntimeClose) {
        if (input.discardPersistentState) {
          const configuredBackend = (meta.backend || input.cfg.acp?.backend || "").trim();
          try {
            await this.deps
              .getRuntimeBackend(configuredBackend || undefined)
              ?.runtime.prepareFreshSession?.({
                sessionKey,
              });
          } catch (error) {
            logVerbose(
              `acp close fast-reset: unable to prepare fresh session for ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        this.clearCachedRuntimeState(sessionKey);
      } else {
        try {
          const { runtime: ensuredRuntime, handle } = await this.ensureRuntimeHandle({
            cfg: input.cfg,
            meta,
            sessionKey,
          });
          await withAcpRuntimeErrorBoundary({
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
            run: async () =>
              await ensuredRuntime.close({
                discardPersistentState: input.discardPersistentState,
                handle,
                reason: input.reason,
              }),
          });
          runtimeClosed = true;
          this.clearCachedRuntimeState(sessionKey);
        } catch (error) {
          const acpError = toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          });
          if (
            input.allowBackendUnavailable &&
            (acpError.code === "ACP_BACKEND_MISSING" ||
              acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
              (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
              this.isRecoverableAcpxExitError(acpError.message))
          ) {
            if (input.discardPersistentState) {
              const configuredBackend = (meta.backend || input.cfg.acp?.backend || "").trim();
              try {
                const runtimeBackend = this.deps.getRuntimeBackend(configuredBackend || undefined);
                if (!runtimeBackend) {
                  throw acpError;
                }
                await runtimeBackend.runtime.prepareFreshSession?.({
                  sessionKey,
                });
              } catch (recoveryError) {
                logVerbose(
                  `acp close recovery: unable to prepare fresh session for ${sessionKey}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
                );
              }
            }
            // Treat unavailable backends as terminal for this cached handle so it
            // Cannot continue counting against maxConcurrentSessions.
            this.clearCachedRuntimeState(sessionKey);
            runtimeNotice = acpError.message;
          } else {
            throw acpError;
          }
        }
      }

      let metaCleared = false;
      if (input.discardPersistentState && !input.clearMeta) {
        await this.discardPersistedRuntimeState({
          cfg: input.cfg,
          sessionKey,
        });
      }

      if (input.clearMeta) {
        await this.writeSessionMeta({
          cfg: input.cfg,
          failOnError: true,
          mutate: (_current, entry) => {
            if (!entry) {
              return null;
            }
            return null;
          },
          sessionKey,
        });
        metaCleared = true;
      }

      return {
        metaCleared,
        runtimeClosed,
        runtimeNotice,
      };
    });
  }

  private async ensureRuntimeHandle(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    meta: SessionAcpMeta;
  }): Promise<{ runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta }> {
    const agent =
      normalizeText(params.meta.agent) || resolveAcpAgentFromSessionKey(params.sessionKey, "main");
    const { mode } = params.meta;
    const runtimeOptions = resolveRuntimeOptionsFromMeta(params.meta);
    const cwd = runtimeOptions.cwd ?? normalizeText(params.meta.cwd);
    const configuredBackend = (params.meta.backend || params.cfg.acp?.backend || "").trim();
    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (cached) {
      const backendMatches = !configuredBackend || cached.backend === configuredBackend;
      const agentMatches = cached.agent === agent;
      const modeMatches = cached.mode === mode;
      const cwdMatches = (cached.cwd ?? "") === (cwd ?? "");
      const handleMatchesMeta = this.runtimeHandleMatchesMeta({
        handle: cached.handle,
        meta: params.meta,
      });
      if (
        backendMatches &&
        agentMatches &&
        modeMatches &&
        cwdMatches &&
        handleMatchesMeta &&
        (await this.isCachedRuntimeHandleReusable({
          handle: cached.handle,
          runtime: cached.runtime,
          sessionKey: params.sessionKey,
        }))
      ) {
        return {
          handle: cached.handle,
          meta: params.meta,
          runtime: cached.runtime,
        };
      }
      this.clearCachedRuntimeState(params.sessionKey);
    }

    this.enforceConcurrentSessionLimit({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });

    const backend = this.deps.requireRuntimeBackend(configuredBackend || undefined);
    const { runtime } = backend;
    const previousMeta = params.meta;
    const previousIdentity = resolveSessionIdentityFromMeta(previousMeta);
    let identityForEnsure = previousIdentity;
    const persistedResumeSessionId =
      mode === "persistent" ? resolveRuntimeResumeSessionId(previousIdentity) : undefined;
    const shouldPrepareFreshPersistentSession =
      mode === "persistent" &&
      previousIdentity != null &&
      !identityHasStableSessionId(previousIdentity);
    const ensureSession = async (resumeSessionId?: string) =>
      await withAcpRuntimeErrorBoundary({
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
        run: async () =>
          await runtime.ensureSession({
            sessionKey: params.sessionKey,
            agent,
            mode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            cwd,
          }),
      });
    let ensured: AcpRuntimeHandle;
    if (shouldPrepareFreshPersistentSession) {
      await runtime.prepareFreshSession?.({
        sessionKey: params.sessionKey,
      });
    }
    if (persistedResumeSessionId) {
      try {
        ensured = await ensureSession(persistedResumeSessionId);
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_SESSION_INIT_FAILED",
          fallbackMessage: "Could not initialize ACP session runtime.",
        });
        if (acpError.code !== "ACP_SESSION_INIT_FAILED") {
          throw acpError;
        }
        logVerbose(
          `acp-manager: resume init failed for ${params.sessionKey}; retrying without persisted ACP session id: ${acpError.message}`,
        );
        if (identityForEnsure) {
          const {
            acpxSessionId: _staleAcpxSessionId,
            agentSessionId: _staleAgentSessionId,
            ...retryIdentity
          } = identityForEnsure;
          // The persisted resume identifiers already failed, so do not merge them back into the
          // Fresh named-session handle returned by the retry path.
          identityForEnsure = {
            ...retryIdentity,
            state: "pending",
          };
        }
        ensured = await ensureSession();
      }
    } else {
      ensured = await ensureSession();
    }

    const now = Date.now();
    const effectiveCwd = normalizeText(ensured.cwd) ?? cwd;
    const nextRuntimeOptions = normalizeRuntimeOptions({
      ...runtimeOptions,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    });
    const nextIdentity =
      mergeSessionIdentity({
        current: identityForEnsure,
        incoming: createIdentityFromEnsure({
          handle: ensured,
          now,
        }),
        now,
      }) ?? identityForEnsure;
    const nextHandleIdentifiers = resolveRuntimeHandleIdentifiersFromIdentity(nextIdentity);
    const nextHandle: AcpRuntimeHandle = {
      ...ensured,
      ...(nextHandleIdentifiers.backendSessionId
        ? { backendSessionId: nextHandleIdentifiers.backendSessionId }
        : {}),
      ...(nextHandleIdentifiers.agentSessionId
        ? { agentSessionId: nextHandleIdentifiers.agentSessionId }
        : {}),
    };
    const nextMeta: SessionAcpMeta = {
      backend: ensured.backend || backend.id,
      agent,
      runtimeSessionName: ensured.runtimeSessionName,
      ...(nextIdentity ? { identity: nextIdentity } : {}),
      mode: params.meta.mode,
      ...(Object.keys(nextRuntimeOptions).length > 0 ? { runtimeOptions: nextRuntimeOptions } : {}),
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      state: previousMeta.state,
      lastActivityAt: now,
      ...(previousMeta.lastError ? { lastError: previousMeta.lastError } : {}),
    };
    const shouldPersistMeta =
      previousMeta.backend !== nextMeta.backend ||
      previousMeta.runtimeSessionName !== nextMeta.runtimeSessionName ||
      !identityEquals(previousIdentity, nextIdentity) ||
      previousMeta.agent !== nextMeta.agent ||
      previousMeta.cwd !== nextMeta.cwd ||
      !runtimeOptionsEqual(previousMeta.runtimeOptions, nextMeta.runtimeOptions) ||
      hasLegacyAcpIdentityProjection(previousMeta);
    if (shouldPersistMeta) {
      await this.writeSessionMeta({
        cfg: params.cfg,
        mutate: (_current, entry) => {
          if (!entry) {
            return null;
          }
          return nextMeta;
        },
        sessionKey: params.sessionKey,
      });
    }
    this.setCachedRuntimeState(params.sessionKey, {
      agent,
      appliedControlSignature: undefined,
      backend: ensured.backend || backend.id,
      cwd: effectiveCwd,
      handle: nextHandle,
      mode,
      runtime,
    });
    return {
      handle: nextHandle,
      meta: nextMeta,
      runtime,
    };
  }

  private async isCachedRuntimeHandleReusable(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<boolean> {
    if (!params.runtime.getStatus) {
      return true;
    }
    try {
      const status = await params.runtime.getStatus({
        handle: params.handle,
      });
      if (this.isRuntimeStatusUnavailable(status)) {
        this.clearCachedRuntimeState(params.sessionKey);
        logVerbose(
          `acp-manager: evicting cached runtime handle for ${params.sessionKey} after unhealthy status probe: ${status.summary ?? "status unavailable"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.clearCachedRuntimeState(params.sessionKey);
      logVerbose(
        `acp-manager: evicting cached runtime handle for ${params.sessionKey} after status probe failed: ${String(error)}`,
      );
      return false;
    }
  }

  private isRuntimeStatusUnavailable(status: AcpRuntimeStatus | undefined): boolean {
    if (!status) {
      return false;
    }
    const detailsStatus = normalizeLowercaseStringOrEmpty(status.details?.status);
    if (detailsStatus === "dead" || detailsStatus === "no-session") {
      return true;
    }
    const summaryMatch = status.summary?.match(/\bstatus=([^\s]+)/i);
    const summaryStatus = normalizeLowercaseStringOrEmpty(summaryMatch?.[1]);
    return summaryStatus === "dead" || summaryStatus === "no-session";
  }

  private async persistRuntimeOptions(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    options: AcpSessionRuntimeOptions;
  }): Promise<void> {
    const normalized = normalizeRuntimeOptions(params.options);
    const hasOptions = Object.keys(normalized).length > 0;
    await this.writeSessionMeta({
      cfg: params.cfg,
      failOnError: true,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        return {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(base.identity ? { identity: base.identity } : {}),
          mode: base.mode,
          runtimeOptions: hasOptions ? normalized : undefined,
          cwd: normalized.cwd,
          state: base.state,
          lastActivityAt: Date.now(),
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
      },
      sessionKey: params.sessionKey,
    });

    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (!cached) {
      return;
    }
    if ((cached.cwd ?? "") !== (normalized.cwd ?? "")) {
      this.clearCachedRuntimeState(params.sessionKey);
      return;
    }
    // Persisting options does not guarantee this process pushed all controls to the runtime.
    // Force the next turn to reconcile runtime controls from persisted metadata.
    cached.appliedControlSignature = undefined;
  }

  private enforceConcurrentSessionLimit(params: { cfg: OpenClawConfig; sessionKey: string }): void {
    const configuredLimit = params.cfg.acp?.maxConcurrentSessions;
    if (typeof configuredLimit !== "number" || !Number.isFinite(configuredLimit)) {
      return;
    }
    const limit = Math.max(1, Math.floor(configuredLimit));
    const actorKey = normalizeActorKey(params.sessionKey);
    if (this.runtimeCache.has(actorKey)) {
      return;
    }
    const activeCount = this.runtimeCache.size();
    if (activeCount >= limit) {
      throw new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP max concurrent sessions reached (${activeCount}/${limit}).`,
      );
    }
  }

  private recordTurnCompletion(params: { startedAt: number; errorCode?: AcpRuntimeError["code"] }) {
    const durationMs = Math.max(0, Date.now() - params.startedAt);
    this.turnLatencyStats.totalMs += durationMs;
    this.turnLatencyStats.maxMs = Math.max(this.turnLatencyStats.maxMs, durationMs);
    if (params.errorCode) {
      this.turnLatencyStats.failed += 1;
      this.recordErrorCode(params.errorCode);
      return;
    }
    this.turnLatencyStats.completed += 1;
  }

  private recordErrorCode(code: string): void {
    const normalized = normalizeAcpErrorCode(code);
    this.errorCountsByCode.set(normalized, (this.errorCountsByCode.get(normalized) ?? 0) + 1);
  }

  private async prepareFreshHandleRetry(params: {
    attempt: number;
    cfg: OpenClawConfig;
    sessionKey: string;
    error: AcpRuntimeError;
    sawTurnOutput: boolean;
    runtime?: AcpRuntime;
    meta?: SessionAcpMeta;
  }): Promise<boolean> {
    if (params.attempt > 0 || params.sawTurnOutput) {
      return false;
    }
    if (this.isRecoverableAcpxExitError(params.error.message)) {
      this.clearCachedRuntimeState(params.sessionKey);
      logVerbose(
        `acp-manager: retrying ${params.sessionKey} with a fresh runtime handle after early turn failure: ${params.error.message}`,
      );
      return true;
    }
    if (
      !params.runtime ||
      !params.meta ||
      params.meta.mode !== "persistent" ||
      !this.isRecoverableMissingPersistentSessionError(params.error.message)
    ) {
      return false;
    }
    const cleared = await this.clearPersistedRuntimeResumeState({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!cleared) {
      return false;
    }
    if (params.runtime.prepareFreshSession) {
      try {
        await params.runtime.prepareFreshSession({
          sessionKey: params.sessionKey,
        });
      } catch (error) {
        logVerbose(
          `acp-manager: failed preparing a fresh persistent session for ${params.sessionKey}: ${formatErrorMessage(error)}`,
        );
        return false;
      }
    }
    this.clearCachedRuntimeState(params.sessionKey);
    logVerbose(
      `acp-manager: retrying ${params.sessionKey} with a fresh persistent session after missing backend resume target: ${params.error.message}`,
    );
    return true;
  }

  private isRecoverableAcpxExitError(message: string): boolean {
    return /^acpx exited with (code \d+|signal [a-z0-9]+)/i.test(message.trim());
  }

  private isRecoverableMissingPersistentSessionError(message: string): boolean {
    const normalized = message.trim();
    return (
      /persistent acp session .* could not be resumed/i.test(normalized) &&
      /(resource not found|no matching session)/i.test(normalized)
    );
  }

  private async clearPersistedRuntimeResumeState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<boolean> {
    const now = Date.now();
    const updated = await this.writeSessionMeta({
      cfg: params.cfg,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        const currentIdentity = resolveSessionIdentityFromMeta(base);
        if (!currentIdentity?.acpxSessionId && !currentIdentity?.agentSessionId) {
          return base;
        }
        const nextIdentity = {
          state: "pending" as const,
          ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
          source: currentIdentity.source,
          lastUpdatedAt: now,
        };
        return {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          identity: nextIdentity,
          mode: base.mode,
          ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
          ...(base.cwd ? { cwd: base.cwd } : {}),
          state: base.state,
          lastActivityAt: now,
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
      },
      sessionKey: params.sessionKey,
    });
    if (!updated) {
      logVerbose(
        `acp-manager: unable to clear persisted runtime resume state for ${params.sessionKey}`,
      );
      return false;
    }
    return true;
  }

  private async discardPersistedRuntimeState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
  }): Promise<void> {
    const now = Date.now();
    await this.writeSessionMeta({
      cfg: params.cfg,
      failOnError: true,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        const currentIdentity = resolveSessionIdentityFromMeta(base);
        const nextIdentity = currentIdentity
          ? {
              state: "pending" as const,
              ...(currentIdentity.acpxRecordId
                ? { acpxRecordId: currentIdentity.acpxRecordId }
                : {}),
              source: currentIdentity.source,
              lastUpdatedAt: now,
            }
          : undefined;
        return {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(nextIdentity ? { identity: nextIdentity } : {}),
          mode: base.mode,
          ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
          ...(base.cwd ? { cwd: base.cwd } : {}),
          state: "idle",
          lastActivityAt: now,
        };
      },
      sessionKey: params.sessionKey,
    });
  }

  private async evictIdleRuntimeHandles(params: { cfg: OpenClawConfig }): Promise<void> {
    const idleTtlMs = resolveRuntimeIdleTtlMs(params.cfg);
    if (idleTtlMs <= 0 || this.runtimeCache.size() === 0) {
      return;
    }
    const now = Date.now();
    const candidates = this.runtimeCache.collectIdleCandidates({
      maxIdleMs: idleTtlMs,
      now,
    });
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      await this.actorQueue.run(candidate.actorKey, async () => {
        if (this.activeTurnBySession.has(candidate.actorKey)) {
          return;
        }
        const lastTouchedAt = this.runtimeCache.getLastTouchedAt(candidate.actorKey);
        if (lastTouchedAt == null || now - lastTouchedAt < idleTtlMs) {
          return;
        }
        const cached = this.runtimeCache.peek(candidate.actorKey);
        if (!cached) {
          return;
        }
        this.runtimeCache.clear(candidate.actorKey);
        this.evictedRuntimeCount += 1;
        this.lastEvictedAt = Date.now();
        try {
          await cached.runtime.close({
            handle: cached.handle,
            reason: "idle-evicted",
          });
        } catch (error) {
          logVerbose(
            `acp-manager: idle eviction close failed for ${candidate.state.handle.sessionKey}: ${String(error)}`,
          );
        }
      });
    }
  }

  private async resolveRuntimeCapabilities(params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> {
    return await resolveManagerRuntimeCapabilities(params);
  }

  private async applyRuntimeControls(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): Promise<void> {
    await applyManagerRuntimeControls({
      ...params,
      getCachedRuntimeState: (sessionKey) => this.getCachedRuntimeState(sessionKey),
    });
  }

  private async setSessionState(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    state: SessionAcpMeta["state"];
    lastError?: string;
    clearLastError?: boolean;
  }): Promise<void> {
    await this.writeSessionMeta({
      cfg: params.cfg,
      mutate: (current, entry) => {
        if (!entry) {
          return null;
        }
        const base = current ?? entry.acp;
        if (!base) {
          return null;
        }
        const next: SessionAcpMeta = {
          backend: base.backend,
          agent: base.agent,
          runtimeSessionName: base.runtimeSessionName,
          ...(base.identity ? { identity: base.identity } : {}),
          mode: base.mode,
          ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
          ...(base.cwd ? { cwd: base.cwd } : {}),
          state: params.state,
          lastActivityAt: Date.now(),
          ...(base.lastError ? { lastError: base.lastError } : {}),
        };
        const lastError = normalizeText(params.lastError);
        if (lastError) {
          next.lastError = lastError;
        } else if (params.clearLastError) {
          delete next.lastError;
        }
        return next;
      },
      sessionKey: params.sessionKey,
    });
  }

  private async reconcileRuntimeSessionIdentifiers(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
    failOnStatusError: boolean;
  }): Promise<{
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    runtimeStatus?: AcpRuntimeStatus;
  }> {
    return await reconcileManagerRuntimeSessionIdentifiers({
      ...params,
      setCachedHandle: (sessionKey, handle) => {
        const cached = this.getCachedRuntimeState(sessionKey);
        if (cached) {
          cached.handle = handle;
        }
      },
      writeSessionMeta: async (writeParams) => await this.writeSessionMeta(writeParams),
    });
  }

  private async writeSessionMeta(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    mutate: (
      current: SessionAcpMeta | undefined,
      entry: SessionEntry | undefined,
    ) => SessionAcpMeta | null | undefined;
    failOnError?: boolean;
  }): Promise<SessionEntry | null> {
    try {
      return await this.deps.upsertSessionMeta({
        cfg: params.cfg,
        mutate: params.mutate,
        sessionKey: params.sessionKey,
      });
    } catch (error) {
      if (params.failOnError) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed persisting ACP metadata for ${params.sessionKey}: ${String(error)}`,
      );
      return null;
    }
  }

  private async withSessionActor<T>(
    sessionKey: string,
    op: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const actorKey = normalizeActorKey(sessionKey);
    this.throwIfAborted(signal);

    let actorStarted = false;
    const queued = this.actorQueue.run(actorKey, async () => {
      actorStarted = true;
      this.throwIfAborted(signal);
      return await op();
    });
    if (!signal) {
      return await queued;
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
      const settleValue = (value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleError = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (actorStarted) {
          return;
        }
        try {
          this.throwIfAborted(signal);
        } catch (error) {
          settleError(error);
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      queued.then(settleValue, settleError);
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP operation aborted.");
  }

  private getCachedRuntimeState(sessionKey: string): CachedRuntimeState | null {
    return this.runtimeCache.get(normalizeActorKey(sessionKey));
  }

  private setCachedRuntimeState(sessionKey: string, state: CachedRuntimeState): void {
    this.runtimeCache.set(normalizeActorKey(sessionKey), state);
  }

  private clearCachedRuntimeState(sessionKey: string): void {
    this.runtimeCache.clear(normalizeActorKey(sessionKey));
  }

  private clearCachedRuntimeStateIfHandleMatches(params: {
    sessionKey: string;
    handle: AcpRuntimeHandle;
  }): void {
    const cached = this.getCachedRuntimeState(params.sessionKey);
    if (!cached || !this.runtimeHandlesMatch(cached.handle, params.handle)) {
      return;
    }
    this.clearCachedRuntimeState(params.sessionKey);
  }

  private runtimeHandlesMatch(a: AcpRuntimeHandle, b: AcpRuntimeHandle): boolean {
    return (
      a.sessionKey === b.sessionKey &&
      a.backend === b.backend &&
      a.runtimeSessionName === b.runtimeSessionName &&
      (a.cwd ?? "") === (b.cwd ?? "") &&
      (a.acpxRecordId ?? "") === (b.acpxRecordId ?? "") &&
      (a.backendSessionId ?? "") === (b.backendSessionId ?? "") &&
      (a.agentSessionId ?? "") === (b.agentSessionId ?? "")
    );
  }

  private runtimeHandleMatchesMeta(params: {
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
  }): boolean {
    const identity = resolveSessionIdentityFromMeta(params.meta);
    const expectedHandleIds = resolveRuntimeHandleIdentifiersFromIdentity(identity);
    if ((params.handle.backendSessionId ?? "") !== (expectedHandleIds.backendSessionId ?? "")) {
      return false;
    }
    if ((params.handle.agentSessionId ?? "") !== (expectedHandleIds.agentSessionId ?? "")) {
      return false;
    }

    const expectedAcpxRecordId = identity?.acpxRecordId ?? "";
    const actualAcpxRecordId =
      normalizeText((params.handle as { acpxRecordId?: unknown }).acpxRecordId) ?? "";
    return actualAcpxRecordId === expectedAcpxRecordId;
  }

  private resolveBackgroundTaskContext(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    requestId: string;
    text: string;
  }): BackgroundTaskContext | null {
    const childEntry = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.entry;
    const requesterSessionKey =
      normalizeText(childEntry?.spawnedBy) ?? normalizeText(childEntry?.parentSessionKey);
    if (!requesterSessionKey) {
      return null;
    }
    const parentEntry = this.deps.readSessionEntry({
      cfg: params.cfg,
      sessionKey: requesterSessionKey,
    })?.entry;
    return {
      childSessionKey: params.sessionKey,
      label: normalizeText(childEntry?.label),
      requesterOrigin: parentEntry?.deliveryContext ?? childEntry?.deliveryContext,
      requesterSessionKey,
      runId: params.requestId,
      task: summarizeBackgroundTaskText(params.text),
    };
  }

  private createBackgroundTaskRecord(context: BackgroundTaskContext, startedAt: number): void {
    try {
      createRunningTaskRun({
        childSessionKey: context.childSessionKey,
        label: context.label,
        ownerKey: context.requesterSessionKey,
        requesterOrigin: context.requesterOrigin,
        runId: context.runId,
        runtime: "acp",
        scopeKind: "session",
        sourceId: context.runId,
        startedAt,
        task: context.task,
      });
    } catch (error) {
      logVerbose(
        `acp-manager: failed creating background task for ${context.runId}: ${String(error)}`,
      );
    }
  }

  private markBackgroundTaskRunning(
    runId: string,
    params: {
      sessionKey?: string;
      lastEventAt?: number;
      progressSummary?: string | null;
    },
  ): void {
    try {
      startTaskRunByRunId({
        lastEventAt: params.lastEventAt,
        progressSummary: params.progressSummary,
        runId,
        runtime: "acp",
        sessionKey: params.sessionKey,
      });
    } catch (error) {
      logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
    }
  }

  private markBackgroundTaskTerminal(
    runId: string,
    params: {
      sessionKey?: string;
      status: "succeeded" | "failed" | "timed_out";
      endedAt: number;
      lastEventAt?: number;
      error?: string;
      progressSummary?: string | null;
      terminalSummary?: string | null;
      terminalOutcome?: "succeeded" | "blocked" | null;
    },
  ): void {
    try {
      if (params.status === "succeeded") {
        completeTaskRunByRunId({
          endedAt: params.endedAt,
          lastEventAt: params.lastEventAt,
          progressSummary: params.progressSummary,
          runId,
          runtime: "acp",
          sessionKey: params.sessionKey,
          terminalOutcome: params.terminalOutcome,
          terminalSummary: params.terminalSummary,
        });
        return;
      }
      failTaskRunByRunId({
        endedAt: params.endedAt,
        error: params.error,
        lastEventAt: params.lastEventAt,
        progressSummary: params.progressSummary,
        runId,
        runtime: "acp",
        sessionKey: params.sessionKey,
        status: params.status,
        terminalSummary: params.terminalSummary,
      });
    } catch (error) {
      logVerbose(`acp-manager: failed updating background task for ${runId}: ${String(error)}`);
    }
  }
}
