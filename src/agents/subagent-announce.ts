import { SILENT_REPLY_TOKEN, isSilentReplyText } from "../auto-reply/tokens.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { type AgentInternalEvent, formatAgentInternalEventsForPrompt } from "./internal-events.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentCompletionOrigin,
  runAnnounceDeliveryWithRetry,
} from "./subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  type SubagentRunOutcome,
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  isEmbeddedPiRunActive,
  loadConfig,
  waitForEmbeddedPiRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SpawnSubagentMode } from "./subagent-spawn.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

interface SubagentAnnounceDeps {
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
}

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  loadConfig,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

let subagentRegistryRuntimePromise: Promise<
  typeof import("./subagent-announce.registry.runtime.js")
> | null = null;

function loadSubagentRegistryRuntime() {
  subagentRegistryRuntimePromise ??= import("./subagent-announce.registry.runtime.js");
  return subagentRegistryRuntimePromise;
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  label?: string;
  task?: string;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  /** Depth of the child being spawned (1 = sub-agent, 2 = sub-sub-agent). */
  childDepth?: number;
  /** Config value: max allowed spawn depth. */
  maxSpawnDepth?: number;
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.replace(/\s+/g, " ").trim()
      : "{{TASK_DESCRIPTION}}";
  const childDepth = typeof params.childDepth === "number" ? params.childDepth : 1;
  const maxSpawnDepth =
    typeof params.maxSpawnDepth === "number"
      ? params.maxSpawnDepth
      : DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const acpEnabled = params.acpEnabled !== false;
  const canSpawn = childDepth < maxSpawnDepth;
  const parentLabel = childDepth >= 2 ? "parent orchestrator" : "main agent";

  const lines = [
    "# Subagent Context",
    "",
    `You are a **subagent** spawned by the ${parentLabel} for a specific task.`,
    "",
    "## Your Role",
    `- You were created to handle: ${taskText}`,
    "- Complete this task. That's your entire purpose.",
    `- You are NOT the ${parentLabel}. Don't try to be.`,
    "",
    "## Rules",
    "1. **Stay focused** - Do your assigned task, nothing else",
    `2. **Complete the task** - Your final message will be automatically reported to the ${parentLabel}`,
    "3. **Don't initiate** - No heartbeats, no proactive actions, no side quests",
    "4. **Be ephemeral** - You may be terminated after task completion. That's fine.",
    "5. **Trust push-based completion** - Descendant results are auto-announced back to you; do not busy-poll for status.",
    "6. **Recover from truncated tool output** - If you see a notice like `[... N more characters truncated]`, assume prior output was reduced. Re-read only what you need using smaller chunks (`read` with offset/limit, or targeted `rg`/`head`/`tail`) instead of full-file `cat`.",
    "",
    "## Output Format",
    "When complete, your final response should include:",
    `- What you accomplished or found`,
    `- Any relevant details the ${parentLabel} should know`,
    "- Keep it concise but informative",
    "",
    "## What You DON'T Do",
    `- NO user conversations (that's ${parentLabel}'s job)`,
    "- NO external messages (email, tweets, etc.) unless explicitly tasked with a specific recipient/channel",
    "- NO cron jobs or persistent state",
    `- NO pretending to be the ${parentLabel}`,
    `- Only use the \`message\` tool when explicitly instructed to contact a specific external recipient; otherwise return plain text and let the ${parentLabel} deliver it`,
    "",
  ];

  if (canSpawn) {
    lines.push(
      "## Sub-Agent Spawning",
      "You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.",
      "Use the `subagents` tool to steer, kill, or do an on-demand status check for your spawned sub-agents.",
      "Your sub-agents will announce their results back to you automatically (not to the main agent).",
      "Default workflow: spawn work, continue orchestrating, and wait for auto-announced completions.",
      "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool.",
      "Wait for completion events to arrive as user messages.",
      "Track expected child session keys and only send your final answer after completion events for ALL expected children arrive.",
      "If a child completion event arrives AFTER you already sent your final answer, reply ONLY with NO_REPLY.",
      "Do NOT repeatedly poll `subagents list` in a loop unless you are actively debugging or intervening.",
      "Coordinate their work and synthesize results before reporting back.",
      ...(acpEnabled
        ? [
            'For ACP harness sessions (codex/claudecode/gemini), use `sessions_spawn` with `runtime: "acp"` (set `agentId` unless `acp.defaultAgent` is configured).',
            '`agents_list` and `subagents` apply to OpenClaw sub-agents (`runtime: "subagent"`); ACP harness ids are controlled by `acp.allowedAgents`.',
            "Do not ask users to run slash commands or CLI when `sessions_spawn` can do it directly.",
            "Do not use `exec` (`openclaw ...`, `acpx ...`) to spawn ACP sessions.",
            'Use `subagents` only for OpenClaw subagents (`runtime: "subagent"`).',
            "Subagent results auto-announce back to you; ACP sessions continue in their bound thread.",
            "Avoid polling loops; spawn, orchestrate, and synthesize results.",
          ]
        : []),
      "",
    );
  } else if (childDepth >= 2) {
    lines.push(
      "## Sub-Agent Spawning",
      "You are a leaf worker and CANNOT spawn further sub-agents. Focus on your assigned task.",
      "",
    );
  }

  lines.push(
    "## Session Context",
    ...[
      params.label ? `- Label: ${params.label}` : undefined,
      params.requesterSessionKey
        ? `- Requester session: ${params.requesterSessionKey}.`
        : undefined,
      params.requesterOrigin?.channel
        ? `- Requester channel: ${params.requesterOrigin.channel}.`
        : undefined,
      `- Your session: ${params.childSessionKey}.`,
    ].filter((line): line is string => line !== undefined),
    "",
  );
  return lines.join("\n");
}

export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function hasUsableSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const { sessionId } = entry as { sessionId?: unknown };
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = subagentAnnounceDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId = "";
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      run: async () =>
        await subagentAnnounceDeps.callGateway({
          method: "agent",
          params: {
            deliver: false,
            idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
            inputProvenance: {
              kind: "inter_session",
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceSessionKey: params.childSessionKey,
              sourceTool: "subagent_announce",
            },
            message: wakeMessage,
            sessionKey: params.childSessionKey,
          },
          timeoutMs: announceTimeoutMs,
        }),
      signal: params.signal,
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
  return replaceSubagentRunAfterSteer({
    nextRunId: wakeRunId,
    preserveFrozenResultFallback: true,
    previousRunId: params.runId,
  });
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = loadSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let { outcome } = params;
    if (childSessionId && isEmbeddedPiRunActive(childSessionId)) {
      const settled = await waitForEmbeddedPiRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedPiRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        return false;
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        endedAt: params.endedAt,
        outcome,
        startedAt: params.startedAt,
        wait,
      });
      ({ outcome } = applied);
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await loadSubagentRegistryRuntime();
      if (
        requesterDepth >= 1 &&
        subagentRegistryRuntime.shouldIgnorePostCompletionAnnounceForSession(
          targetRequesterSessionKey,
        )
      ) {
        return true;
      }

      const pendingChildDescendantRuns = Math.max(
        0,
        subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey),
      );
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return false;
      }

      if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
        const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(
          params.childSessionKey,
          {
            requesterRunId: params.childRunId,
          },
        );
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                getLatestSubagentRunByChildSessionKey:
                  subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey,
                requesterSessionKey: params.childSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childRunId: params.childRunId,
      childSessionKey: params.childSessionKey,
    });

    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childRunId: stripWakeRunSuffixes(params.childRunId),
        childSessionKey: params.childSessionKey,
      });
      const woke = await wakeSubagentRunAfterDescendants({
        announceId: wakeAnnounceId,
        childSessionKey: params.childSessionKey,
        findings: childCompletionFindings,
        runId: params.childRunId,
        signal: params.signal,
        taskLabel: params.label || params.task || "task",
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return true;
      }
    }

    if (!childCompletionFindings) {
      const fallbackReply = normalizeOptionalString(params.fallbackReply);
      const fallbackIsSilent =
        Boolean(fallbackReply) &&
        (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));

      if (!reply) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (!reply?.trim()) {
        reply = await readLatestSubagentOutputWithRetry({
          maxWaitMs: params.timeoutMs,
          outcome,
          sessionKey: params.childSessionKey,
        });
      }

      if (!reply?.trim() && fallbackReply && !fallbackIsSilent) {
        reply = fallbackReply;
      }

      // A worker can finish just after the first wait request timed out.
      // If we already have real completion content, do one cached recheck so
      // The final completion event prefers the authoritative terminal state.
      // This is best-effort; if the recheck fails, keep the known timeout
      // Outcome instead of dropping the announcement entirely.
      if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
        try {
          const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
          const applied = applySubagentWaitOutcome({
            endedAt: params.endedAt,
            outcome,
            startedAt: params.startedAt,
            wait: rechecked,
          });
          ({ outcome } = applied);
          params.startedAt = applied.startedAt;
          params.endedAt = applied.endedAt;
        } catch {
          // Best-effort recheck; keep the existing timeout outcome on failure.
        }
      }

      if (isAnnounceSkip(reply) || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (fallbackReply && !fallbackIsSilent) {
          reply = fallbackReply;
        } else {
          return true;
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    const findings = childCompletionFindings || reply || "(no output)";

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      const {
        isSubagentSessionRunActive,
        resolveRequesterForChildSession,
        shouldIgnorePostCompletionAnnounceForSession,
      } = subagentRegistryRuntime ?? (await loadSubagentRegistryRuntime());
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        if (shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return true;
        }
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            shouldDeleteChildSession = false;
            return false;
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

    const replyInstruction = buildAnnounceReplyInstruction({
      announceType,
      expectsCompletionMessage,
      requesterIsSubagent,
    });
    const statsLine = await buildCompactAnnounceStatsLine({
      endedAt: params.endedAt,
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
    });
    const internalEvents: AgentInternalEvent[] = [
      {
        announceType,
        childSessionId: announceSessionId,
        childSessionKey: params.childSessionKey,
        replyInstruction,
        result: findings,
        source: announceType === "cron job" ? "cron" : "subagent",
        statsLine,
        status: outcome.status,
        statusLabel,
        taskLabel,
        type: "task_completion",
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);

    // Send to the requester session. For nested subagents this is an internal
    // Follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const completionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? await resolveSubagentCompletionOrigin({
            childRunId: params.childRunId,
            childSessionKey: params.childSessionKey,
            expectsCompletionMessage,
            requesterOrigin: directOrigin,
            requesterSessionKey: targetRequesterSessionKey,
            spawnMode: params.spawnMode,
          })
        : targetRequesterOrigin;
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    const delivery = await deliverSubagentAnnouncement({
      announceId,
      bestEffortDeliver: params.bestEffortDeliver,
      completionDirectOrigin,
      directIdempotencyKey,
      directOrigin,
      expectsCompletionMessage,
      internalEvents,
      requesterIsSubagent,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      requesterSessionKey: targetRequesterSessionKey,
      requesterSessionOrigin: targetRequesterOrigin,
      signal: params.signal,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceSessionKey: params.childSessionKey,
      sourceTool: "subagent_announce",
      steerMessage: triggerMessage,
      summaryLine: taskLabel,
      targetRequesterSessionKey,
      triggerMessage,
    });
    didAnnounce = delivery.delivered;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.error?.(
        `Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (error) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(error)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.delete",
          params: {
            deleteTranscript: true,
            emitLifecycleHooks: params.spawnMode === "session",
            key: params.childSessionKey,
          },
          timeoutMs: 10_000,
        });
      } catch {
        // Ignore
      }
    }
  }
  return didAnnounce;
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeps>) {
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeps;
  },
};
