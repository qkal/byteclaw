import crypto from "node:crypto";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { SILENT_REPLY_TOKEN, isSilentReplyText } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  resolveQueuedReplyExecutionConfig,
  resolveQueuedReplyRuntimeConfig,
  resolveRunAuthProfile,
} from "./agent-runner-utils.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { type FollowupRun, refreshQueuedFollowupSession } from "./queue.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

export function createFollowupRunner(params: {
  opts?: GetReplyOptions;
  typing: TypingController;
  typingMode: TypingMode;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): (queued: FollowupRun) => Promise<void> {
  const {
    opts,
    typing,
    typingMode,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  } = params;
  const typingSignals = createTypingSignaler({
    isHeartbeat: opts?.isHeartbeat === true,
    mode: typingMode,
    typing,
  });

  /**
   * Sends followup payloads, routing to the originating channel if set.
   *
   * When originatingChannel/originatingTo are set on the queued run,
   * replies are routed directly to that provider instead of using the
   * session's current dispatcher. This ensures replies go back to
   * where the message originated.
   */
  const sendFollowupPayloads = async (payloads: ReplyPayload[], queued: FollowupRun) => {
    // Check if we should route to originating channel.
    const { originatingChannel, originatingTo } = queued;
    const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
    const shouldRouteToOriginating = isRoutableChannel(originatingChannel) && originatingTo;

    if (!shouldRouteToOriginating && !opts?.onBlockReply) {
      logVerbose("followup queue: no onBlockReply handler; dropping payloads");
      return;
    }

    for (const payload of payloads) {
      if (!payload || !hasOutboundReplyContent(payload)) {
        continue;
      }
      if (
        isSilentReplyText(payload.text, SILENT_REPLY_TOKEN) &&
        !resolveSendableOutboundReplyParts(payload).hasMedia
      ) {
        continue;
      }
      await typingSignals.signalTextDelta(payload.text);

      // Route to originating channel if set, otherwise fall back to dispatcher.
      if (shouldRouteToOriginating) {
        const result = await routeReply({
          accountId: queued.originatingAccountId,
          cfg: runtimeConfig,
          channel: originatingChannel,
          payload,
          sessionKey: queued.run.sessionKey,
          threadId: queued.originatingThreadId,
          to: originatingTo,
        });
        if (!result.ok) {
          const errorMsg = result.error ?? "unknown error";
          logVerbose(`followup queue: route-reply failed: ${errorMsg}`);
          // Fall back to the caller-provided dispatcher only when the
          // Originating channel matches the session's message provider.
          // In that case onBlockReply was created by the same channel's
          // Handler and delivers to the correct destination.  For true
          // Cross-channel routing (origin !== provider), falling back
          // Would send to the wrong channel, so we drop the payload.
          const provider = resolveOriginMessageProvider({
            provider: queued.run.messageProvider,
          });
          const origin = resolveOriginMessageProvider({
            originatingChannel,
          });
          if (opts?.onBlockReply && origin && origin === provider) {
            await opts.onBlockReply(payload);
          }
        }
      } else if (opts?.onBlockReply) {
        await opts.onBlockReply(payload);
      }
    }
  };

  return async (queued: FollowupRun) => {
    queued.run.config = await resolveQueuedReplyExecutionConfig(queued.run.config);
    const replySessionKey = queued.run.sessionKey ?? sessionKey;
    const runtimeConfig = resolveQueuedReplyRuntimeConfig(queued.run.config);
    const effectiveQueued =
      runtimeConfig === queued.run.config
        ? queued
        : { ...queued, run: { ...queued.run, config: runtimeConfig } };
    const {run} = effectiveQueued;
    const replyOperation = createReplyOperation({
      resetTriggered: false,
      sessionId: run.sessionId,
      sessionKey: replySessionKey ?? "",
      upstreamAbortSignal: opts?.abortSignal,
    });
    try {
      const runId = crypto.randomUUID();
      const shouldSurfaceToControlUi = isInternalMessageChannel(
        resolveOriginMessageProvider({
          originatingChannel: queued.originatingChannel,
          provider: run.messageProvider,
        }),
      );
      if (run.sessionKey) {
        registerAgentRunContext(runId, {
          isControlUiVisible: shouldSurfaceToControlUi,
          sessionKey: run.sessionKey,
          verboseLevel: run.verboseLevel,
        });
      }
      let autoCompactionCount = 0;
      let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
      let fallbackProvider = run.provider;
      let fallbackModel = run.model;
      let activeSessionEntry =
        (sessionKey ? sessionStore?.[sessionKey] : undefined) ?? sessionEntry;
      activeSessionEntry = await runPreflightCompactionIfNeeded({
        agentCfgContextTokens,
        cfg: runtimeConfig,
        defaultModel,
        followupRun: effectiveQueued,
        isHeartbeat: opts?.isHeartbeat === true,
        promptForEstimate: queued.prompt,
        replyOperation,
        sessionEntry: activeSessionEntry,
        sessionKey,
        sessionStore,
        storePath,
      });
      let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
        activeSessionEntry?.systemPromptReport,
      );
      replyOperation.setPhase("running");
      try {
        const fallbackResult = await runWithModelFallback({
          agentDir: run.agentDir,
          cfg: runtimeConfig,
          fallbacksOverride: resolveRunModelFallbacksOverride({
            agentId: run.agentId,
            cfg: runtimeConfig,
            sessionKey: run.sessionKey,
          }),
          model: run.model,
          provider: run.provider,
          run: async (provider, model, runOptions) => {
            const authProfile = resolveRunAuthProfile(run, provider);
            let attemptCompactionCount = 0;
            try {
              const result = await runEmbeddedPiAgent({
                allowGatewaySubagentBinding: true,
                replyOperation,
                sessionId: run.sessionId,
                sessionKey: run.sessionKey,
                agentId: run.agentId,
                trigger: "user",
                messageChannel: queued.originatingChannel ?? undefined,
                messageProvider: run.messageProvider,
                agentAccountId: run.agentAccountId,
                messageTo: queued.originatingTo,
                messageThreadId: queued.originatingThreadId,
                currentChannelId: queued.originatingTo,
                currentThreadTs:
                  queued.originatingThreadId != null
                    ? String(queued.originatingThreadId)
                    : undefined,
                groupId: run.groupId,
                groupChannel: run.groupChannel,
                groupSpace: run.groupSpace,
                senderId: run.senderId,
                senderName: run.senderName,
                senderUsername: run.senderUsername,
                senderE164: run.senderE164,
                senderIsOwner: run.senderIsOwner,
                sessionFile: run.sessionFile,
                agentDir: run.agentDir,
                workspaceDir: run.workspaceDir,
                config: runtimeConfig,
                skillsSnapshot: run.skillsSnapshot,
                prompt: queued.prompt,
                extraSystemPrompt: run.extraSystemPrompt,
                ownerNumbers: run.ownerNumbers,
                enforceFinalTag: run.enforceFinalTag,
                provider,
                model,
                ...authProfile,
                thinkLevel: run.thinkLevel,
                verboseLevel: run.verboseLevel,
                reasoningLevel: run.reasoningLevel,
                suppressToolErrorWarnings: opts?.suppressToolErrorWarnings,
                execOverrides: run.execOverrides,
                bashElevated: run.bashElevated,
                timeoutMs: run.timeoutMs,
                runId,
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                blockReplyBreak: run.blockReplyBreak,
                bootstrapPromptWarningSignaturesSeen,
                bootstrapPromptWarningSignature:
                  bootstrapPromptWarningSignaturesSeen[
                    bootstrapPromptWarningSignaturesSeen.length - 1
                  ],
                onAgentEvent: (evt) => {
                  if (evt.stream !== "compaction") {
                    return;
                  }
                  const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
                  const completed = evt.data?.completed === true;
                  if (phase === "end" && completed) {
                    attemptCompactionCount += 1;
                  }
                },
              });
              bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
                result.meta?.systemPromptReport,
              );
              const resultCompactionCount = Math.max(
                0,
                result.meta?.agentMeta?.compactionCount ?? 0,
              );
              attemptCompactionCount = Math.max(attemptCompactionCount, resultCompactionCount);
              return result;
            } finally {
              autoCompactionCount += attemptCompactionCount;
            }
          },
          runId,
        });
        runResult = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
      } catch (error) {
        const message = formatErrorMessage(error);
        replyOperation.fail("run_failed", error);
        defaultRuntime.error?.(`Followup agent failed before reply: ${message}`);
        return;
      }

      const usage = runResult.meta?.agentMeta?.usage;
      const promptTokens = runResult.meta?.agentMeta?.promptTokens;
      const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
      const providerUsed =
        runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? queued.run.provider;
      const contextTokensUsed =
        resolveContextTokensForModel({
          allowAsyncLoad: false,
          cfg: queued.run.config,
          contextTokensOverride: agentCfgContextTokens,
          fallbackContextTokens: sessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
          model: modelUsed,
          provider: providerUsed,
        }) ?? DEFAULT_CONTEXT_TOKENS;

      if (storePath && sessionKey) {
        await persistRunSessionUsage({
          cfg: runtimeConfig,
          cliSessionBinding: runResult.meta?.agentMeta?.cliSessionBinding,
          contextTokensUsed,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          logLabel: "followup",
          modelUsed,
          promptTokens,
          providerUsed,
          sessionKey,
          storePath,
          systemPromptReport: runResult.meta?.systemPromptReport,
          usage,
          usageIsContextSnapshot: isCliProvider(providerUsed, runtimeConfig),
        });
      }

      const payloadArray = runResult.payloads ?? [];
      if (payloadArray.length === 0) {
        return;
      }
      const sanitizedPayloads = payloadArray.flatMap((payload) => {
        const {text} = payload;
        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [payload];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        const {hasMedia} = resolveSendableOutboundReplyParts(payload);
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });
      const finalPayloads = resolveFollowupDeliveryPayloads({
        cfg: runtimeConfig,
        messageProvider: run.messageProvider,
        originatingAccountId: queued.originatingAccountId ?? run.agentAccountId,
        originatingChannel: queued.originatingChannel,
        originatingChatType: queued.originatingChatType,
        originatingTo: queued.originatingTo,
        payloads: sanitizedPayloads,
        sentMediaUrls: runResult.messagingToolSentMediaUrls,
        sentTargets: runResult.messagingToolSentTargets,
        sentTexts: runResult.messagingToolSentTexts,
      });

      if (finalPayloads.length === 0) {
        return;
      }

      if (autoCompactionCount > 0) {
        const previousSessionId = run.sessionId;
        const count = await incrementRunCompactionCount({
          amount: autoCompactionCount,
          cfg: runtimeConfig,
          contextTokensUsed,
          lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
          newSessionId: runResult.meta?.agentMeta?.sessionId,
          sessionEntry,
          sessionKey,
          sessionStore,
          storePath,
        });
        const refreshedSessionEntry =
          sessionKey && sessionStore ? sessionStore[sessionKey] : undefined;
        if (refreshedSessionEntry) {
          const queueKey = run.sessionKey ?? sessionKey;
          if (queueKey) {
            refreshQueuedFollowupSession({
              key: queueKey,
              nextSessionFile: refreshedSessionEntry.sessionFile,
              nextSessionId: refreshedSessionEntry.sessionId,
              previousSessionId,
            });
          }
        }
        if (run.verboseLevel && run.verboseLevel !== "off") {
          const suffix = typeof count === "number" ? ` (count ${count})` : "";
          finalPayloads.unshift({
            text: `🧹 Auto-compaction complete${suffix}.`,
          });
        }
      }

      await sendFollowupPayloads(finalPayloads, effectiveQueued);
    } finally {
      replyOperation.complete();
      // Both signals are required for the typing controller to clean up.
      // The main inbound dispatch path calls markDispatchIdle() from the
      // Buffered dispatcher's finally block, but followup turns bypass the
      // Dispatcher entirely — so we must fire both signals here.  Without
      // This, NO_REPLY / empty-payload followups leave the typing indicator
      // Stuck (the keepalive loop keeps sending "typing" to Telegram
      // Indefinitely until the TTL expires).
      typing.markRunComplete();
      typing.markDispatchIdle();
    }
  };
}
