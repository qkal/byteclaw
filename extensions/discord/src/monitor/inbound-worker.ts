import { createRunStateMachine } from "openclaw/plugin-sdk/channel-lifecycle";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { danger, formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { type DiscordInboundJob, materializeDiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import { processDiscordMessage } from "./message-handler.process.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { resolveDiscordReplyDeliveryPlan } from "./threading.js";
import { normalizeDiscordInboundWorkerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

interface DiscordInboundWorkerParams {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  runTimeoutMs?: number;
  __testing?: DiscordInboundWorkerTestingHooks;
}

export interface DiscordInboundWorker {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
}

export interface DiscordInboundWorkerTestingHooks {
  processDiscordMessage?: typeof processDiscordMessage;
  deliverDiscordReply?: typeof deliverDiscordReply;
}

function formatDiscordRunContextSuffix(job: DiscordInboundJob): string {
  const channelId = job.payload.messageChannelId?.trim();
  const messageId = job.payload.data?.message?.id?.trim();
  const details = [
    channelId ? `channelId=${channelId}` : null,
    messageId ? `messageId=${messageId}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (details.length === 0) {
    return "";
  }
  return ` (${details.join(", ")})`;
}

async function processDiscordInboundJob(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  lifecycleSignal?: AbortSignal;
  runTimeoutMs?: number;
  testing?: DiscordInboundWorkerTestingHooks;
}) {
  const timeoutMs = normalizeDiscordInboundWorkerTimeoutMs(params.runTimeoutMs);
  const contextSuffix = formatDiscordRunContextSuffix(params.job);
  let finalReplyStarted = false;
  let createdThreadId: string | undefined;
  let sessionKey: string | undefined;
  const processDiscordMessageImpl = params.testing?.processDiscordMessage ?? processDiscordMessage;
  await runDiscordTaskWithTimeout({
    abortSignals: [params.job.runtime.abortSignal, params.lifecycleSignal],
    onErrorAfterTimeout: (error) => {
      params.runtime.error?.(
        danger(`discord inbound worker failed after timeout: ${String(error)}${contextSuffix}`),
      );
    },
    onTimeout: async (resolvedTimeoutMs) => {
      params.runtime.error?.(
        danger(
          `discord inbound worker timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
            decimals: 1,
            unit: "seconds",
          })}${contextSuffix}`,
        ),
      );
      if (finalReplyStarted) {
        return;
      }
      await sendDiscordInboundWorkerTimeoutReply({
        contextSuffix,
        createdThreadId,
        deliverDiscordReplyImpl: params.testing?.deliverDiscordReply,
        job: params.job,
        runtime: params.runtime,
        sessionKey,
      });
    },
    run: async (abortSignal) => {
      await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal), {
        onFinalReplyDelivered: () => {
          finalReplyStarted = true;
        },
        onFinalReplyStart: () => {
          finalReplyStarted = true;
        },
        onReplyPlanResolved: (resolved) => {
          createdThreadId = normalizeOptionalString(resolved.createdThreadId);
          sessionKey = normalizeOptionalString(resolved.sessionKey);
        },
      });
    },
    timeoutMs,
  });
}

async function sendDiscordInboundWorkerTimeoutReply(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  contextSuffix: string;
  createdThreadId?: string;
  sessionKey?: string;
  deliverDiscordReplyImpl?: typeof deliverDiscordReply;
}) {
  const messageChannelId = params.job.payload.messageChannelId?.trim();
  const messageId = params.job.payload.message?.id?.trim();
  const token = params.job.payload.token?.trim();
  if (!messageChannelId || !messageId || !token) {
    params.runtime.error?.(
      danger(
        `discord inbound worker timeout reply skipped: missing reply target${params.contextSuffix}`,
      ),
    );
    return;
  }

  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    createdThreadId: params.createdThreadId,
    messageId,
    replyTarget: `channel:${params.job.payload.threadChannel?.id ?? messageChannelId}`,
    replyToMode: params.job.payload.replyToMode,
    threadChannel: params.job.payload.threadChannel,
  });

  try {
    await (params.deliverDiscordReplyImpl ?? deliverDiscordReply)({
      accountId: params.job.payload.accountId,
      cfg: params.job.payload.cfg,
      maxLinesPerMessage: params.job.payload.discordConfig?.maxLinesPerMessage,
      replies: [{ isError: true, text: "Discord inbound worker timed out." }],
      replyToId: deliveryPlan.replyReference.use(),
      replyToMode: params.job.payload.replyToMode,
      runtime: params.runtime,
      sessionKey:
        params.sessionKey ??
        params.job.payload.route.sessionKey ??
        params.job.payload.baseSessionKey,
      target: deliveryPlan.deliverTarget,
      textLimit: params.job.payload.textLimit,
      threadBindings: params.job.runtime.threadBindings,
      token,
    });
  } catch (error) {
    params.runtime.error?.(
      danger(
        `discord inbound worker timeout reply failed: ${String(error)}${params.contextSuffix}`,
      ),
    );
  }
}

export function createDiscordInboundWorker(
  params: DiscordInboundWorkerParams,
): DiscordInboundWorker {
  const runQueue = new KeyedAsyncQueue();
  const runState = createRunStateMachine({
    abortSignal: params.abortSignal,
    setStatus: params.setStatus,
  });

  return {
    deactivate: runState.deactivate,
    enqueue(job) {
      void runQueue
        .enqueue(job.queueKey, async () => {
          if (!runState.isActive()) {
            return;
          }
          runState.onRunStart();
          try {
            if (!runState.isActive()) {
              return;
            }
            await processDiscordInboundJob({
              job,
              lifecycleSignal: params.abortSignal,
              runTimeoutMs: params.runTimeoutMs,
              runtime: params.runtime,
              testing: params.__testing,
            });
          } finally {
            runState.onRunEnd();
          }
        })
        .catch((error) => {
          params.runtime.error?.(danger(`discord inbound worker failed: ${String(error)}`));
        });
    },
  };
}
