import { randomUUID } from "node:crypto";
import { listAgentIds } from "../../agents/agent-scope.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import {
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSpawnedRun,
} from "../../agents/spawned-context.js";
import { buildBareSessionResetPrompt } from "../../auto-reply/reply/session-reset-prompt.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  type SessionEntry,
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveExplicitAgentSessionKey,
  updateSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { shouldDowngradeDeliveryToSessionOnly } from "../../infra/outbound/best-effort-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { type InputProvenance, normalizeInputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createRunningTaskRun } from "../../tasks/task-executor.js";
import {
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { MediaOffloadError, parseMessageWithAttachments } from "../chat-attachments.js";
import { resolveAssistantAvatarUrl } from "../control-ui-shared.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  canonicalizeSpawnedByForAgent,
  loadGatewaySessionRow,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import {
  type AgentWaitTerminalSnapshot,
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;

function resolveSenderIsOwnerFromClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function resolveAllowModelOverrideFromClient(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return resolveSenderIsOwnerFromClient(client) || client?.internal?.allowModelOverride === true;
}

function resolveCanResetSessionFromClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  return resolveSenderIsOwnerFromClient(client);
}

async function runSessionResetFromAgent(params: {
  key: string;
  reason: "new" | "reset";
}): Promise<
  | { ok: true; key: string; sessionId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const result = await performGatewaySessionReset({
    commandSource: "gateway:agent",
    key: params.key,
    reason: params.reason,
  });
  if (!result.ok) {
    return result;
  }
  return {
    key: result.key,
    ok: true,
    sessionId: result.entry.sessionId,
  };
}

function emitSessionsChanged(
  context: Pick<
    GatewayRequestHandlerOptions["context"],
    "broadcastToConnIds" | "getSessionEventSubscriberConnIds"
  >,
  payload: { sessionKey?: string; reason: string },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            abortedLastRun: sessionRow.abortedLastRun,
            channel: sessionRow.channel,
            chatType: sessionRow.chatType,
            childSessions: sessionRow.childSessions,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            contextTokens: sessionRow.contextTokens,
            deliveryContext: sessionRow.deliveryContext,
            displayName: sessionRow.displayName,
            elevatedLevel: sessionRow.elevatedLevel,
            endedAt: sessionRow.endedAt,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            fastMode: sessionRow.fastMode,
            forkedFromParent: sessionRow.forkedFromParent,
            groupChannel: sessionRow.groupChannel,
            inputTokens: sessionRow.inputTokens,
            kind: sessionRow.kind,
            label: sessionRow.label,
            lastAccountId: sessionRow.lastAccountId,
            lastChannel: sessionRow.lastChannel,
            lastThreadId: sessionRow.lastThreadId,
            lastTo: sessionRow.lastTo,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
            model: sessionRow.model,
            modelProvider: sessionRow.modelProvider,
            origin: sessionRow.origin,
            outputTokens: sessionRow.outputTokens,
            parentSessionKey: sessionRow.parentSessionKey,
            reasoningLevel: sessionRow.reasoningLevel,
            responseUsage: sessionRow.responseUsage,
            runtimeMs: sessionRow.runtimeMs,
            sendPolicy: sessionRow.sendPolicy,
            sessionId: sessionRow.sessionId,
            space: sessionRow.space,
            spawnDepth: sessionRow.spawnDepth,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            startedAt: sessionRow.startedAt,
            status: sessionRow.status,
            subagentControlScope: sessionRow.subagentControlScope,
            subagentRole: sessionRow.subagentRole,
            subject: sessionRow.subject,
            systemSent: sessionRow.systemSent,
            thinkingLevel: sessionRow.thinkingLevel,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            updatedAt: sessionRow.updatedAt ?? undefined,
            verboseLevel: sessionRow.verboseLevel,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromIngress>[0];
  runId: string;
  idempotencyKey: string;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  const inputProvenance = normalizeInputProvenance(params.ingressOpts.inputProvenance);
  const shouldTrackTask =
    params.ingressOpts.sessionKey?.trim() && inputProvenance?.kind !== "inter_session";
  if (shouldTrackTask) {
    try {
      createRunningTaskRun({
        childSessionKey: params.ingressOpts.sessionKey,
        deliveryStatus: "not_applicable",
        ownerKey: params.ingressOpts.sessionKey,
        requesterOrigin: normalizeDeliveryContext({
          channel: params.ingressOpts.channel,
          to: params.ingressOpts.to,
          accountId: params.ingressOpts.accountId,
          threadId: params.ingressOpts.threadId,
        }),
        runId: params.runId,
        runtime: "cli",
        scopeKind: "session",
        sourceId: params.runId,
        startedAt: Date.now(),
        task: params.ingressOpts.message,
      });
    } catch {
      // Best-effort only: background task tracking must not block agent runs.
    }
  }
  void agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps)
    .then((result) => {
      const payload = {
        result,
        runId: params.runId,
        status: "ok" as const,
        summary: "completed",
      };
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        entry: {
          ok: true,
          payload,
          ts: Date.now(),
        },
        key: `agent:${params.idempotencyKey}`,
      });
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.respond(true, payload, undefined, { runId: params.runId });
    })
    .catch((error) => {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(error));
      const payload = {
        runId: params.runId,
        status: "error" as const,
        summary: String(error),
      };
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `agent:${params.idempotencyKey}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      params.respond(false, payload, error, {
        runId: params.runId,
        error: formatForLog(error),
      });
    });
}

export const agentHandlers: GatewayRequestHandlers = {
  agent: async ({ params, respond, context, client, isWebchatConnect }) => {
    const p = params;
    if (!validateAgentParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      message: string;
      agentId?: string;
      provider?: string;
      model?: string;
      to?: string;
      replyTo?: string;
      sessionId?: string;
      sessionKey?: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: {
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }[];
      channel?: string;
      replyChannel?: string;
      accountId?: string;
      replyAccountId?: string;
      threadId?: string;
      groupId?: string;
      groupChannel?: string;
      groupSpace?: string;
      lane?: string;
      extraSystemPrompt?: string;
      bootstrapContextMode?: "full" | "lightweight";
      bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
      internalEvents?: AgentInternalEvent[];
      idempotencyKey: string;
      timeout?: number;
      bestEffortDeliver?: boolean;
      label?: string;
      inputProvenance?: InputProvenance;
    };
    const senderIsOwner = resolveSenderIsOwnerFromClient(client);
    const allowModelOverride = resolveAllowModelOverrideFromClient(client);
    const canResetSession = resolveCanResetSessionFromClient(client);
    const requestedModelOverride = Boolean(request.provider || request.model);
    if (requestedModelOverride && !allowModelOverride) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "provider/model overrides are not authorized for this caller.",
        ),
      );
      return;
    }
    const providerOverride = allowModelOverride ? request.provider : undefined;
    const modelOverride = allowModelOverride ? request.model : undefined;
    const cfg = loadConfig();
    const idem = request.idempotencyKey;
    const normalizedSpawned = normalizeSpawnedRunMetadata({
      groupChannel: request.groupChannel,
      groupId: request.groupId,
      groupSpace: request.groupSpace,
    });
    let resolvedGroupId: string | undefined = normalizedSpawned.groupId;
    let resolvedGroupChannel: string | undefined = normalizedSpawned.groupChannel;
    let resolvedGroupSpace: string | undefined = normalizedSpawned.groupSpace;
    let spawnedByValue: string | undefined;
    const inputProvenance = normalizeInputProvenance(request.inputProvenance);
    const cached = context.dedupe.get(`agent:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);
    const requestedBestEffortDeliver =
      typeof request.bestEffortDeliver === "boolean" ? request.bestEffortDeliver : undefined;

    let message = (request.message ?? "").trim();
    let images: { type: "image"; data: string; mimeType: string }[] = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    if (normalizedAttachments.length > 0) {
      const requestedSessionKeyRaw =
        typeof request.sessionKey === "string" && request.sessionKey.trim()
          ? request.sessionKey.trim()
          : undefined;

      let baseProvider: string | undefined;
      let baseModel: string | undefined;
      if (requestedSessionKeyRaw) {
        const { cfg: sessCfg, entry: sessEntry } = loadSessionEntry(requestedSessionKeyRaw);
        const modelRef = resolveSessionModelRef(sessCfg, sessEntry, undefined);
        baseProvider = modelRef.provider;
        baseModel = modelRef.model;
      }
      const effectiveProvider = providerOverride || baseProvider;
      const effectiveModel = modelOverride || baseModel;
      const supportsImages = await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        model: effectiveModel,
        provider: effectiveProvider,
      });

      try {
        const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
          log: context.logGateway,
          maxBytes: 5_000_000,
          supportsImages,
        });
        message = parsed.message.trim();
        ({ images } = parsed);
        ({ imageOrder } = parsed);
        // OffloadedRefs are appended as text markers to `message`; the agent
        // Runner will resolve them via detectAndLoadPromptImages.
      } catch (error) {
        // MediaOffloadError indicates a server-side storage fault (ENOSPC, EPERM,
        // etc.). Map it to UNAVAILABLE so clients can retry without treating it as
        // a bad request. All other errors are input-validation failures → 4xx.
        const isServerFault = error instanceof MediaOffloadError;
        respond(
          false,
          undefined,
          errorShape(
            isServerFault ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(error),
          ),
        );
        return;
      }
    }

    const isKnownGatewayChannel = (value: string): boolean => isGatewayMessageChannel(value);
    const channelHints = [request.channel, request.replyChannel]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const rawChannel of channelHints) {
      const normalized = normalizeMessageChannel(rawChannel);
      if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown channel: ${String(normalized)}`,
          ),
        );
        return;
      }
    }

    const agentIdRaw = normalizeOptionalString(request.agentId) ?? "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (agentId) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown agent id "${request.agentId}"`,
          ),
        );
        return;
      }
    }

    const requestedSessionKeyRaw = normalizeOptionalString(request.sessionKey);
    if (
      requestedSessionKeyRaw &&
      classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent"
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: malformed session key "${requestedSessionKeyRaw}"`,
        ),
      );
      return;
    }
    let requestedSessionKey =
      requestedSessionKeyRaw ??
      resolveExplicitAgentSessionKey({
        agentId,
        cfg,
      });
    if (agentId && requestedSessionKeyRaw) {
      const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
      if (sessionAgentId !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`,
          ),
        );
        return;
      }
    }
    let resolvedSessionId = normalizeOptionalString(request.sessionId);
    let sessionEntry: SessionEntry | undefined;
    let bestEffortDeliver = requestedBestEffortDeliver ?? false;
    let cfgForAgent: ReturnType<typeof loadConfig> | undefined;
    let resolvedSessionKey = requestedSessionKey;
    let isNewSession = false;
    let skipTimestampInjection = false;

    const resetCommandMatch = message.match(RESET_COMMAND_RE);
    if (resetCommandMatch && requestedSessionKey) {
      if (!canResetSession) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${ADMIN_SCOPE}`),
        );
        return;
      }
      const resetReason =
        normalizeOptionalLowercaseString(resetCommandMatch[1]) === "new" ? "new" : "reset";
      const resetResult = await runSessionResetFromAgent({
        key: requestedSessionKey,
        reason: resetReason,
      });
      if (!resetResult.ok) {
        respond(false, undefined, resetResult.error);
        return;
      }
      requestedSessionKey = resetResult.key;
      resolvedSessionId = resetResult.sessionId ?? resolvedSessionId;
      const postResetMessage = normalizeOptionalString(resetCommandMatch[2]) ?? "";
      if (postResetMessage) {
        message = postResetMessage;
      } else {
        // Keep bare /new and /reset behavior aligned with chat.send:
        // Reset first, then run a fresh-session greeting prompt in-place.
        // Date is embedded in the prompt so agents read the correct daily
        // Memory files; skip further timestamp injection to avoid duplication.
        message = buildBareSessionResetPrompt(cfg);
        skipTimestampInjection = true;
      }
    }

    // Inject timestamp into user-authored messages that don't already have one.
    // Channel messages (Discord, Telegram, etc.) get timestamps via envelope
    // Formatting in a separate code path — they never reach this handler.
    // See: https://github.com/openclaw/openclaw/issues/3658
    if (!skipTimestampInjection) {
      message = injectTimestamp(message, timestampOptsFromConfig(cfg));
    }

    if (requestedSessionKey) {
      const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
      cfgForAgent = cfg;
      isNewSession = !entry;
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      const labelValue = normalizeOptionalString(request.label) || entry?.label;
      const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
      spawnedByValue = canonicalizeSpawnedByForAgent(cfg, sessionAgent, entry?.spawnedBy);
      let inheritedGroup:
        | { groupId?: string; groupChannel?: string; groupSpace?: string }
        | undefined;
      if (spawnedByValue && (!resolvedGroupId || !resolvedGroupChannel || !resolvedGroupSpace)) {
        try {
          const parentEntry = loadSessionEntry(spawnedByValue)?.entry;
          inheritedGroup = {
            groupChannel: parentEntry?.groupChannel,
            groupId: parentEntry?.groupId,
            groupSpace: parentEntry?.space,
          };
        } catch {
          inheritedGroup = undefined;
        }
      }
      resolvedGroupId = resolvedGroupId || inheritedGroup?.groupId;
      resolvedGroupChannel = resolvedGroupChannel || inheritedGroup?.groupChannel;
      resolvedGroupSpace = resolvedGroupSpace || inheritedGroup?.groupSpace;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      const nextEntryPatch: SessionEntry = {
        channel: entry?.channel ?? request.channel?.trim(),
        claudeCliSessionId: entry?.claudeCliSessionId,
        cliSessionIds: entry?.cliSessionIds,
        deliveryContext: deliveryFields.deliveryContext,
        fastMode: entry?.fastMode,
        groupChannel: resolvedGroupChannel ?? entry?.groupChannel,
        groupId: resolvedGroupId ?? entry?.groupId,
        label: labelValue,
        lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
        lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
        lastThreadId: deliveryFields.lastThreadId ?? entry?.lastThreadId,
        lastTo: deliveryFields.lastTo ?? entry?.lastTo,
        modelOverride: entry?.modelOverride,
        providerOverride: entry?.providerOverride,
        reasoningLevel: entry?.reasoningLevel,
        sendPolicy: entry?.sendPolicy,
        sessionId,
        skillsSnapshot: entry?.skillsSnapshot,
        space: resolvedGroupSpace ?? entry?.space,
        spawnDepth: entry?.spawnDepth,
        spawnedBy: spawnedByValue,
        spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
        systemSent: entry?.systemSent,
        thinkingLevel: entry?.thinkingLevel,
        updatedAt: now,
        verboseLevel: entry?.verboseLevel,
      };
      sessionEntry = mergeSessionEntry(entry, nextEntryPatch);
      const sendPolicy = resolveSendPolicy({
        cfg,
        channel: entry?.channel,
        chatType: entry?.chatType,
        entry,
        sessionKey: canonicalKey,
      });
      if (sendPolicy === "deny") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
        );
        return;
      }
      resolvedSessionId = sessionId;
      const canonicalSessionKey = canonicalKey;
      resolvedSessionKey = canonicalSessionKey;
      const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
      const mainSessionKey = resolveAgentMainSessionKey({ agentId, cfg });
      if (storePath) {
        const persisted = await updateSessionStore(storePath, (store) => {
          const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
            cfg,
            key: requestedSessionKey,
            store,
          });
          const merged = mergeSessionEntry(store[primaryKey], nextEntryPatch);
          store[primaryKey] = merged;
          return merged;
        });
        sessionEntry = persisted;
      }
      if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
        context.addChatRun(idem, {
          clientRunId: idem,
          sessionKey: canonicalSessionKey,
        });
        if (requestedBestEffortDeliver === undefined) {
          bestEffortDeliver = true;
        }
      }
      registerAgentRunContext(idem, { sessionKey: canonicalSessionKey });
    }

    const runId = idem;
    const connId = typeof client?.connId === "string" ? client.connId : undefined;
    const wantsToolEvents = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    );
    if (connId && wantsToolEvents) {
      context.registerToolEventRecipient(runId, connId);
      // Register for any other active runs *in the same session* so
      // Late-joining clients (e.g. page refresh mid-response) receive
      // In-progress tool events without leaking cross-session data.
      for (const [activeRunId, active] of context.chatAbortControllers) {
        if (activeRunId !== runId && active.sessionKey === requestedSessionKey) {
          context.registerToolEventRecipient(activeRunId, connId);
        }
      }
    }

    const wantsDelivery = request.deliver === true;
    const explicitTo =
      normalizeOptionalString(request.replyTo) ?? normalizeOptionalString(request.to);
    const explicitThreadId = normalizeOptionalString(request.threadId);
    const turnSourceChannel = normalizeOptionalString(request.channel);
    const turnSourceTo = normalizeOptionalString(request.to);
    const turnSourceAccountId = normalizeOptionalString(request.accountId);
    const deliveryPlan = resolveAgentDeliveryPlan({
      accountId: request.replyAccountId ?? request.accountId,
      explicitThreadId,
      explicitTo,
      requestedChannel: request.replyChannel ?? request.channel,
      sessionEntry,
      turnSourceAccountId,
      turnSourceChannel,
      turnSourceThreadId: explicitThreadId,
      turnSourceTo,
      wantsDelivery,
    });

    let {resolvedChannel} = deliveryPlan;
    let {deliveryTargetMode} = deliveryPlan;
    const resolvedAccountId = deliveryPlan.resolvedAccountId;
    let {resolvedTo} = deliveryPlan;
    let effectivePlan = deliveryPlan;
    let deliveryDowngradeReason: string | null = null;

    if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
      const cfgResolved = cfgForAgent ?? cfg;
      try {
        const selection = await resolveMessageChannelSelection({ cfg: cfgResolved });
        resolvedChannel = selection.channel;
        deliveryTargetMode = deliveryTargetMode ?? "implicit";
        effectivePlan = {
          ...deliveryPlan,
          deliveryTargetMode,
          resolvedAccountId,
          resolvedChannel,
        };
      } catch (error) {
        const shouldDowngrade = shouldDowngradeDeliveryToSessionOnly({
          wantsDelivery,
          bestEffortDeliver,
          resolvedChannel,
        });
        if (!shouldDowngrade) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
          return;
        }
        deliveryDowngradeReason = String(error);
      }
    }

    if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
      const cfgResolved = cfgForAgent ?? cfg;
      const fallback = resolveAgentOutboundTarget({
        cfg: cfgResolved,
        plan: effectivePlan,
        targetMode: deliveryTargetMode ?? "implicit",
        validateExplicitTarget: false,
      });
      if (fallback.resolvedTarget?.ok) {
        ({ resolvedTo } = fallback);
      }
    }

    if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
      const shouldDowngrade = shouldDowngradeDeliveryToSessionOnly({
        bestEffortDeliver,
        resolvedChannel,
        wantsDelivery,
      });
      if (!shouldDowngrade) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
          ),
        );
        return;
      }
      context.logGateway.info(
        deliveryDowngradeReason
          ? `agent delivery downgraded to session-only (bestEffortDeliver): ${deliveryDowngradeReason}`
          : "agent delivery downgraded to session-only (bestEffortDeliver): no deliverable channel",
      );
    }

    const normalizedTurnSource = normalizeMessageChannel(turnSourceChannel);
    const turnSourceMessageChannel =
      normalizedTurnSource && isGatewayMessageChannel(normalizedTurnSource)
        ? normalizedTurnSource
        : undefined;
    const originMessageChannel =
      turnSourceMessageChannel ??
      (client?.connect && isWebchatConnect(client.connect)
        ? INTERNAL_MESSAGE_CHANNEL
        : resolvedChannel);

    const deliver = request.deliver === true && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;

    const accepted = {
      acceptedAt: Date.now(),
      runId,
      status: "accepted" as const,
    };
    // Store an in-flight ack so retries do not spawn a second run.
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      entry: {
        ok: true,
        payload: accepted,
        ts: Date.now(),
      },
      key: `agent:${idem}`,
    });
    respond(true, accepted, undefined, { runId });

    if (resolvedSessionKey) {
      await reactivateCompletedSubagentSession({
        runId,
        sessionKey: resolvedSessionKey,
      });
    }

    if (requestedSessionKey && resolvedSessionKey && isNewSession) {
      emitSessionsChanged(context, {
        reason: "create",
        sessionKey: resolvedSessionKey,
      });
    }
    if (resolvedSessionKey) {
      emitSessionsChanged(context, {
        reason: "send",
        sessionKey: resolvedSessionKey,
      });
    }

    const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;

    dispatchAgentRunFromGateway({
      context,
      idempotencyKey: idem,
      ingressOpts: {
        message,
        images,
        imageOrder,
        provider: providerOverride,
        model: modelOverride,
        to: resolvedTo,
        sessionId: resolvedSessionId,
        sessionKey: resolvedSessionKey,
        thinking: request.thinking,
        deliver,
        deliveryTargetMode,
        channel: resolvedChannel,
        accountId: resolvedAccountId,
        threadId: resolvedThreadId,
        runContext: {
          messageChannel: originMessageChannel,
          accountId: resolvedAccountId,
          groupId: resolvedGroupId,
          groupChannel: resolvedGroupChannel,
          groupSpace: resolvedGroupSpace,
          currentThreadTs: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
        },
        groupId: resolvedGroupId,
        groupChannel: resolvedGroupChannel,
        groupSpace: resolvedGroupSpace,
        spawnedBy: spawnedByValue,
        timeout: request.timeout?.toString(),
        bestEffortDeliver,
        messageChannel: originMessageChannel,
        runId,
        lane: request.lane,
        extraSystemPrompt: request.extraSystemPrompt,
        bootstrapContextMode: request.bootstrapContextMode,
        bootstrapContextRunKind: request.bootstrapContextRunKind,
        internalEvents: request.internalEvents,
        inputProvenance,
        // Internal-only: allow workspace override for spawned subagent runs.
        workspaceDir: resolveIngressWorkspaceOverrideForSpawnedRun({
          spawnedBy: spawnedByValue,
          workspaceDir: sessionEntry?.spawnedWorkspaceDir,
        }),
        senderIsOwner,
        allowModelOverride,
      },
      respond,
      runId,
    });
  },
  "agent.identity.get": ({ params, respond }) => {
    if (!validateAgentIdentityParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: ${formatValidationErrors(
            validateAgentIdentityParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params;
    const agentIdRaw = normalizeOptionalString(p.agentId) ?? "";
    const sessionKeyRaw = normalizeOptionalString(p.sessionKey) ?? "";
    let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (sessionKeyRaw) {
      if (classifySessionKeyShape(sessionKeyRaw) === "malformed_agent") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: malformed session key "${sessionKeyRaw}"`,
          ),
        );
        return;
      }
      const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
      if (agentId && resolved !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`,
          ),
        );
        return;
      }
      agentId = resolved;
    }
    const cfg = loadConfig();
    const identity = resolveAssistantIdentity({ agentId, cfg });
    const avatarValue =
      resolveAssistantAvatarUrl({
        agentId: identity.agentId,
        avatar: identity.avatar,
        basePath: cfg.gateway?.controlUi?.basePath,
      }) ?? identity.avatar;
    respond(true, { ...identity, avatar: avatarValue }, undefined);
  },
  "agent.wait": async ({ params, respond, context }) => {
    if (!validateAgentWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const runId = (p.runId ?? "").trim();
    const timeoutMs =
      typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
        ? Math.max(0, Math.floor(p.timeoutMs))
        : 30_000;
    const hasActiveChatRun = context.chatAbortControllers.has(runId);

    const cachedGatewaySnapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe: context.dedupe,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
      runId,
    });
    if (cachedGatewaySnapshot) {
      respond(true, {
        endedAt: cachedGatewaySnapshot.endedAt,
        error: cachedGatewaySnapshot.error,
        runId,
        startedAt: cachedGatewaySnapshot.startedAt,
        status: cachedGatewaySnapshot.status,
      });
      return;
    }

    const lifecycleAbortController = new AbortController();
    const dedupeAbortController = new AbortController();
    const lifecyclePromise = waitForAgentJob({
      runId,
      timeoutMs,
      signal: lifecycleAbortController.signal,
      // When chat.send is active with the same runId, ignore cached lifecycle
      // Snapshots so stale agent results do not preempt the active chat run.
      ignoreCachedSnapshot: hasActiveChatRun,
    });
    const dedupePromise = waitForTerminalGatewayDedupe({
      dedupe: context.dedupe,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
      runId,
      signal: dedupeAbortController.signal,
      timeoutMs,
    });

    const first = await Promise.race([
      lifecyclePromise.then((snapshot) => ({ snapshot, source: "lifecycle" as const })),
      dedupePromise.then((snapshot) => ({ snapshot, source: "dedupe" as const })),
    ]);

    let {snapshot} = first;
    if (snapshot) {
      if (first.source === "lifecycle") {
        dedupeAbortController.abort();
      } else {
        lifecycleAbortController.abort();
      }
    } else {
      snapshot = first.source === "lifecycle" ? await dedupePromise : await lifecyclePromise;
      lifecycleAbortController.abort();
      dedupeAbortController.abort();
    }

    if (!snapshot) {
      respond(true, {
        runId,
        status: "timeout",
      });
      return;
    }
    respond(true, {
      endedAt: snapshot.endedAt,
      error: snapshot.error,
      runId,
      startedAt: snapshot.startedAt,
      status: snapshot.status,
    });
  },
};
