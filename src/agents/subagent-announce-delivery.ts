import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey, resolveQueueAnnounceId } from "./announce-idempotency.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  getGlobalHookRunner,
  isEmbeddedPiRunActive,
  loadConfig,
  loadSessionStore,
  queueEmbeddedPiMessage,
  resolveAgentIdFromSessionKey,
  resolveConversationIdFromTargets,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  resolveStorePath,
} from "./subagent-announce-delivery.runtime.js";
import {
  type SubagentAnnounceDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";
import { type DeliveryContext, resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
import type { SpawnSubagentMode } from "./subagent-spawn.js";

export { resolveAnnounceOrigin } from "./subagent-announce-origin.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;

interface SubagentAnnounceDeliveryDeps {
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
}

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  callGateway,
  loadConfig,
};

let subagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps =
  defaultSubagentAnnounceDeliveryDeps;

function resolveDirectAnnounceTransientRetryDelaysMs() {
  return process.env.OPENCLAW_TEST_FAST === "1"
    ? ([8, 16, 32] as const)
    : ([5000, 10_000, 20_000] as const);
}

export function resolveSubagentAnnounceTimeoutMs(cfg: ReturnType<typeof loadConfig>): number {
  const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.floor(configured)), MAX_TIMER_SAFE_TIMEOUT_MS);
}

export function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean {
  return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}

function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

const TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
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

function isTransientAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

async function waitForAnnounceRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  let retryIndex = 0;
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (error) {
      const delayMs = retryDelaysMs[retryIndex];
      if (delayMs == null || !isTransientAnnounceDeliveryError(error) || params.signal?.aborted) {
        throw error;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      defaultRuntime.log(
        `[warn] Subagent announce ${params.operation} transient failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDeliveryError(error)}`,
      );
      retryIndex += 1;
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
}

export async function resolveSubagentCompletionOrigin(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childRunId?: string;
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined> {
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
  const to = requesterOrigin?.to?.trim();
  const accountId = normalizeAccountId(requesterOrigin?.accountId);
  const threadId =
    requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
      ? String(requesterOrigin.threadId).trim()
      : undefined;
  const conversationId =
    threadId ||
    resolveConversationIdFromTargets({
      targets: [to],
    }) ||
    "";
  const requesterConversation: ConversationRef | undefined =
    channel && conversationId ? { accountId, channel, conversationId } : undefined;

  const route = createBoundDeliveryRouter().resolveDestination({
    eventKind: "task_completion",
    failClosed: false,
    requester: requesterConversation,
    targetSessionKey: params.childSessionKey,
  });
  if (route.mode === "bound" && route.binding) {
    const boundTarget = resolveConversationDeliveryTarget({
      channel: route.binding.conversation.channel,
      conversationId: route.binding.conversation.conversationId,
      parentConversationId: route.binding.conversation.parentConversationId,
    });
    return mergeDeliveryContext(
      {
        accountId: route.binding.conversation.accountId,
        channel: route.binding.conversation.channel,
        threadId:
          boundTarget.threadId ??
          (requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
            ? String(requesterOrigin.threadId)
            : undefined),
        to: boundTarget.to,
      },
      requesterOrigin,
    );
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_delivery_target")) {
    return requesterOrigin;
  }
  try {
    const result = await hookRunner.runSubagentDeliveryTarget(
      {
        childRunId: params.childRunId,
        childSessionKey: params.childSessionKey,
        expectsCompletionMessage: params.expectsCompletionMessage,
        requesterOrigin,
        requesterSessionKey: params.requesterSessionKey,
        spawnMode: params.spawnMode,
      },
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        runId: params.childRunId,
      },
    );
    const hookOrigin = normalizeDeliveryContext(result?.origin);
    if (!hookOrigin) {
      return requesterOrigin;
    }
    if (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel)) {
      return requesterOrigin;
    }
    return mergeDeliveryContext(hookOrigin, requesterOrigin);
  } catch {
    return requesterOrigin;
  }
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const requesterIsSubagent = isInternalAnnounceRequesterSession(item.sessionKey);
  const { origin } = item;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  const idempotencyKey = buildAnnounceIdempotencyKey(
    resolveQueueAnnounceId({
      announceId: item.announceId,
      enqueuedAt: item.enqueuedAt,
      sessionKey: item.sessionKey,
    }),
  );
  await subagentAnnounceDeliveryDeps.callGateway({
    method: "agent",
    params: {
      accountId: requesterIsSubagent ? undefined : origin?.accountId,
      channel: requesterIsSubagent ? undefined : origin?.channel,
      deliver: !requesterIsSubagent,
      idempotencyKey,
      inputProvenance: {
        kind: "inter_session",
        sourceChannel: item.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
        sourceSessionKey: item.sourceSessionKey,
        sourceTool: item.sourceTool ?? "subagent_announce",
      },
      internalEvents: item.internalEvents,
      message: item.prompt,
      sessionKey: item.sessionKey,
      threadId: requesterIsSubagent ? undefined : threadId,
      to: requesterIsSubagent ? undefined : origin?.to,
    },
    timeoutMs: announceTimeoutMs,
  });
}

export function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { canonicalKey, cfg, entry };
}

export function loadSessionEntryByKey(sessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  return store[sessionKey];
}

function buildAnnounceQueueKey(sessionKey: string, origin?: DeliveryContext): string {
  const accountId = normalizeAccountId(origin?.accountId);
  if (!accountId) {
    return sessionKey;
  }
  return `${sessionKey}:acct:${accountId}`;
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  internalEvents?: AgentInternalEvent[];
  signal?: AbortSignal;
}): Promise<"steered" | "queued" | "none" | "dropped"> {
  if (params.signal?.aborted) {
    return "none";
  }
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
    sessionEntry: entry,
  });
  const isActive = isEmbeddedPiRunActive(sessionId);

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = queueEmbeddedPiMessage(sessionId, params.steerMessage);
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    const didQueue = enqueueAnnounce({
      item: {
        announceId: params.announceId,
        enqueuedAt: Date.now(),
        internalEvents: params.internalEvents,
        origin,
        prompt: params.triggerMessage,
        sessionKey: canonicalKey,
        sourceChannel: params.sourceChannel,
        sourceSessionKey: params.sourceSessionKey,
        sourceTool: params.sourceTool,
        summaryLine: params.summaryLine,
      },
      key: buildAnnounceQueueKey(canonicalKey, origin),
      send: sendAnnounce,
      settings: queueSettings,
    });
    return didQueue ? "queued" : "dropped";
  }

  return "none";
}

async function sendSubagentAnnounceDirectly(params: {
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  requesterIsSubagent: boolean;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return {
      delivered: false,
      path: "none",
    };
  }
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
  );
  try {
    const completionDirectOrigin = normalizeDeliveryContext(params.completionDirectOrigin);
    const directOrigin = normalizeDeliveryContext(params.directOrigin);
    const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
    // Merge completionDirectOrigin with directOrigin so that missing fields
    // (channel, to, accountId) fall back to the originating session's
    // LastChannel / lastTo. Without this, a completion origin that carries a
    // Channel but not a `to` would prevent external delivery.
    const effectiveDirectOrigin =
      params.expectsCompletionMessage && completionDirectOrigin
        ? mergeDeliveryContext(completionDirectOrigin, directOrigin)
        : directOrigin;
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const deliveryTarget = !params.requesterIsSubagent
      ? resolveExternalBestEffortDeliveryTarget({
          accountId: effectiveDirectOrigin?.accountId,
          channel: effectiveDirectOrigin?.channel,
          threadId: effectiveDirectOrigin?.threadId,
          to: effectiveDirectOrigin?.to,
        })
      : { deliver: false };
    const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent
      ? normalizeMessageChannel(sessionOnlyOrigin?.channel)
      : undefined;
    const sessionOnlyOriginChannel =
      normalizedSessionOnlyOriginChannel &&
      isGatewayMessageChannel(normalizedSessionOnlyOriginChannel)
        ? normalizedSessionOnlyOriginChannel
        : undefined;
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
    await runAnnounceDeliveryWithRetry({
      operation: params.expectsCompletionMessage
        ? "completion direct announce agent call"
        : "direct announce agent call",
      run: async () =>
        await subagentAnnounceDeliveryDeps.callGateway({
          expectFinal: true,
          method: "agent",
          params: {
            accountId: deliveryTarget.deliver
              ? deliveryTarget.accountId
              : sessionOnlyOriginChannel
                ? sessionOnlyOrigin?.accountId
                : undefined,
            bestEffortDeliver: params.bestEffortDeliver,
            channel: deliveryTarget.deliver ? deliveryTarget.channel : sessionOnlyOriginChannel,
            deliver: deliveryTarget.deliver,
            idempotencyKey: params.directIdempotencyKey,
            inputProvenance: {
              kind: "inter_session",
              sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
              sourceSessionKey: params.sourceSessionKey,
              sourceTool: params.sourceTool ?? "subagent_announce",
            },
            internalEvents: params.internalEvents,
            message: params.triggerMessage,
            sessionKey: canonicalRequesterSessionKey,
            threadId: deliveryTarget.deliver
              ? deliveryTarget.threadId
              : sessionOnlyOriginChannel
                ? sessionOnlyOrigin?.threadId
                : undefined,
            to: deliveryTarget.deliver
              ? deliveryTarget.to
              : sessionOnlyOriginChannel
                ? sessionOnlyOrigin?.to
                : undefined,
          },
          timeoutMs: announceTimeoutMs,
        }),
      signal: params.signal,
    });

    return {
      delivered: true,
      path: "direct",
    };
  } catch (error) {
    return {
      delivered: false,
      error: summarizeDeliveryError(error),
      path: "direct",
    };
  }
}

export async function deliverSubagentAnnouncement(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  internalEvents?: AgentInternalEvent[];
  summaryLine?: string;
  requesterSessionOrigin?: DeliveryContext;
  requesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  return await runSubagentAnnounceDispatch({
    direct: async () =>
      await sendSubagentAnnounceDirectly({
        bestEffortDeliver: params.bestEffortDeliver,
        completionDirectOrigin: params.completionDirectOrigin,
        directIdempotencyKey: params.directIdempotencyKey,
        directOrigin: params.directOrigin,
        expectsCompletionMessage: params.expectsCompletionMessage,
        internalEvents: params.internalEvents,
        requesterIsSubagent: params.requesterIsSubagent,
        requesterSessionOrigin: params.requesterSessionOrigin,
        signal: params.signal,
        sourceChannel: params.sourceChannel,
        sourceSessionKey: params.sourceSessionKey,
        sourceTool: params.sourceTool,
        targetRequesterSessionKey: params.targetRequesterSessionKey,
        triggerMessage: params.triggerMessage,
      }),
    expectsCompletionMessage: params.expectsCompletionMessage,
    queue: async () =>
      await maybeQueueSubagentAnnounce({
        announceId: params.announceId,
        internalEvents: params.internalEvents,
        requesterOrigin: params.requesterOrigin,
        requesterSessionKey: params.requesterSessionKey,
        signal: params.signal,
        sourceChannel: params.sourceChannel,
        sourceSessionKey: params.sourceSessionKey,
        sourceTool: params.sourceTool,
        steerMessage: params.steerMessage,
        summaryLine: params.summaryLine,
        triggerMessage: params.triggerMessage,
      }),
    signal: params.signal,
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>) {
    subagentAnnounceDeliveryDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeliveryDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeliveryDeps;
  },
};
