import type { webhook } from "@line/bot-sdk";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  chunkMarkdownText,
  dispatchReplyWithBufferedBlockDispatcher,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  type RuntimeEnv,
  danger,
  logVerbose,
  waitForAbortSignal,
} from "openclaw/plugin-sdk/runtime-env";
import {
  normalizePluginHttpPath,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveDefaultLineAccountId } from "./accounts.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { createLineBot } from "./bot.js";
import { processLineMessage } from "./markdown-to-line.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import {
  createFlexMessage,
  createImageMessage,
  createLocationMessage,
  createQuickReplyItems,
  createTextMessageWithQuickReplies,
  getUserDisplayName,
  pushMessageLine,
  pushMessagesLine,
  pushTextMessageWithQuickReplies,
  replyMessageLine,
  showLoadingAnimation,
} from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData, ResolvedLineAccount } from "./types.js";
import { createLineNodeWebhookHandler } from "./webhook-node.js";

export interface MonitorLineProviderOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookUrl?: string;
  webhookPath?: string;
}

export interface LineProviderMonitor {
  account: ResolvedLineAccount;
  handleWebhook: (body: webhook.CallbackRequest) => Promise<void>;
  stop: () => void;
}

const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();
const lineWebhookInFlightLimiter = createWebhookInFlightLimiter();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    lastError: null,
    lastStartAt: null,
    lastStopAt: null,
    running: false,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getLineRuntimeState(accountId: string) {
  return runtimeState.get(`line:${accountId}`);
}

export function clearLineRuntimeStateForTests() {
  runtimeState.clear();
}

function startLineLoadingKeepalive(params: {
  userId: string;
  accountId?: string;
  intervalMs?: number;
  loadingSeconds?: number;
}): () => void {
  const intervalMs = params.intervalMs ?? 18_000;
  const loadingSeconds = params.loadingSeconds ?? 20;
  let stopped = false;

  const trigger = () => {
    if (stopped) {
      return;
    }
    void showLoadingAnimation(params.userId, {
      accountId: params.accountId,
      loadingSeconds,
    }).catch(() => {});
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

export async function monitorLineProvider(
  opts: MonitorLineProviderOptions,
): Promise<LineProviderMonitor> {
  const {
    channelAccessToken,
    channelSecret,
    accountId,
    config,
    runtime,
    abortSignal,
    webhookPath,
  } = opts;
  const resolvedAccountId = accountId ?? resolveDefaultLineAccountId(config);
  const token = channelAccessToken.trim();
  const secret = channelSecret.trim();

  if (!token) {
    throw new Error("LINE webhook mode requires a non-empty channel access token.");
  }
  if (!secret) {
    throw new Error("LINE webhook mode requires a non-empty channel secret.");
  }

  recordChannelRuntimeState({
    accountId: resolvedAccountId,
    channel: "line",
    state: {
      lastStartAt: Date.now(),
      running: true,
    },
  });

  const bot = createLineBot({
    accountId,
    channelAccessToken: token,
    channelSecret: secret,
    config,
    onMessage: async (ctx) => {
      if (!ctx) {
        return;
      }

      const { ctxPayload, replyToken, route } = ctx;

      recordChannelRuntimeState({
        accountId: resolvedAccountId,
        channel: "line",
        state: {
          lastInboundAt: Date.now(),
        },
      });

      const shouldShowLoading = Boolean(ctx.userId && !ctx.isGroup);

      const displayNamePromise = ctx.userId
        ? getUserDisplayName(ctx.userId, { accountId: ctx.accountId })
        : Promise.resolve(ctxPayload.From);

      const stopLoading = shouldShowLoading
        ? startLineLoadingKeepalive({ accountId: ctx.accountId, userId: ctx.userId! })
        : null;

      const displayName = await displayNamePromise;
      logVerbose(`line: received message from ${displayName} (${ctxPayload.From})`);

      try {
        const textLimit = 5000;
        let replyTokenUsed = false;
        const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
          accountId: route.accountId,
          agentId: route.agentId,
          cfg: config,
          channel: "line",
        });

        const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
          cfg: config,
          ctx: ctxPayload,
          dispatcherOptions: {
            ...replyPipeline,
            deliver: async (payload, _info) => {
              const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};

              if (ctx.userId && !ctx.isGroup) {
                void showLoadingAnimation(ctx.userId, { accountId: ctx.accountId }).catch(() => {});
              }

              const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({
                payload,
                lineData,
                to: ctxPayload.From,
                replyToken,
                replyTokenUsed,
                accountId: ctx.accountId,
                textLimit,
                deps: {
                  buildTemplateMessageFromPayload,
                  processLineMessage,
                  chunkMarkdownText,
                  sendLineReplyChunks,
                  replyMessageLine,
                  pushMessageLine,
                  pushTextMessageWithQuickReplies,
                  createQuickReplyItems,
                  createTextMessageWithQuickReplies,
                  pushMessagesLine,
                  createFlexMessage,
                  createImageMessage,
                  createLocationMessage,
                  onReplyError: (replyErr) => {
                    logVerbose(
                      `line: reply token failed, falling back to push: ${String(replyErr)}`,
                    );
                  },
                },
              });
              replyTokenUsed = nextReplyTokenUsed;

              recordChannelRuntimeState({
                channel: "line",
                accountId: resolvedAccountId,
                state: {
                  lastOutboundAt: Date.now(),
                },
              });
            },
            onError: (err, info) => {
              runtime.error?.(danger(`line ${info.kind} reply failed: ${String(err)}`));
            },
          },
          replyOptions: {
            onModelSelected,
          },
        });

        if (!queuedFinal) {
          logVerbose(`line: no response generated for message from ${ctxPayload.From}`);
        }
      } catch (error) {
        runtime.error?.(danger(`line: auto-reply failed: ${String(error)}`));

        if (replyToken) {
          try {
            await replyMessageLine(
              replyToken,
              [{ text: "Sorry, I encountered an error processing your message.", type: "text" }],
              { accountId: ctx.accountId },
            );
          } catch (error) {
            runtime.error?.(danger(`line: error reply failed: ${String(error)}`));
          }
        }
      } finally {
        stopLoading?.();
      }
    },
    runtime,
  });

  const normalizedPath = normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook";
  const createScopedLineWebhookHandler = (onRequestAuthenticated?: () => void) =>
    createLineNodeWebhookHandler({
      bot,
      channelSecret: secret,
      onRequestAuthenticated,
      runtime,
    });
  const unregisterHttp = registerPluginHttpRoute({
    accountId: resolvedAccountId,
    auth: "plugin",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        await createScopedLineWebhookHandler()(req, res);
        return;
      }

      const requestLifecycle = beginWebhookRequestPipelineOrReject({
        inFlightKey: `line:${resolvedAccountId}`,
        inFlightLimiter: lineWebhookInFlightLimiter,
        req,
        res,
      });
      if (!requestLifecycle.ok) {
        return;
      }

      try {
        await createScopedLineWebhookHandler(requestLifecycle.release)(req, res);
      } finally {
        requestLifecycle.release();
      }
    },
    log: (msg) => logVerbose(msg),
    path: normalizedPath,
    pluginId: "line",
    replaceExisting: true,
  });

  logVerbose(`line: registered webhook handler at ${normalizedPath}`);

  let stopped = false;
  const stopHandler = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    logVerbose(`line: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
    recordChannelRuntimeState({
      accountId: resolvedAccountId,
      channel: "line",
      state: {
        lastStopAt: Date.now(),
        running: false,
      },
    });
  };

  if (abortSignal?.aborted) {
    stopHandler();
  } else if (abortSignal) {
    abortSignal.addEventListener("abort", stopHandler, { once: true });
    await waitForAbortSignal(abortSignal);
  }

  return {
    account: bot.account,
    handleWebhook: bot.handleWebhook,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
