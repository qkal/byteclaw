import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import type { OutboundMirror } from "./mirror.js";
import { extractToolPayload } from "./tool-payload.js";

export interface OutboundGatewayContext {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
}

export interface OutboundSendContext {
  cfg: OpenClawConfig;
  channel: ChannelId;
  params: Record<string, unknown>;
  /** Active agent id for per-agent outbound media root scoping. */
  agentId?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaReadFile?: OutboundMediaReadFile;
  accountId?: string | null;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: OutboundMirror;
  abortSignal?: AbortSignal;
  silent?: boolean;
}

interface PluginHandledResult {
  handledBy: "plugin";
  payload: unknown;
  toolResult: AgentToolResult<unknown>;
}

function collectActionMediaSources(params: Record<string, unknown>): string[] {
  const sources: string[] = [];
  for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      sources.push(value);
    }
  }
  return sources;
}

async function tryHandleWithPluginAction(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  onHandled?: () => Promise<void> | void;
}): Promise<PluginHandledResult | null> {
  if (params.ctx.dryRun) {
    return null;
  }
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    agentId: params.ctx.agentId ?? params.ctx.mirror?.agentId,
    cfg: params.ctx.cfg,
    mediaAccess: params.ctx.mediaAccess,
    mediaReadFile: params.ctx.mediaReadFile,
    mediaSources: collectActionMediaSources(params.ctx.params),
  });
  const handled = await dispatchChannelMessageAction({
    accountId: params.ctx.accountId ?? undefined,
    action: params.action,
    cfg: params.ctx.cfg,
    channel: params.ctx.channel,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
    mediaAccess,
    mediaLocalRoots: mediaAccess.localRoots,
    mediaReadFile: mediaAccess.readFile,
    params: params.ctx.params,
    toolContext: params.ctx.toolContext,
  });
  if (!handled) {
    return null;
  }
  await params.onHandled?.();
  return {
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

export async function executeSendAction(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  forceDocument?: boolean;
  bestEffort?: boolean;
  replyToId?: string;
  threadId?: string | number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  throwIfAborted(params.ctx.abortSignal);
  const pluginHandled = await tryHandleWithPluginAction({
    action: "send",
    ctx: params.ctx,
    onHandled: async () => {
      if (!params.ctx.mirror) {
        return;
      }
      const mirrorText = params.ctx.mirror.text ?? params.message;
      const mirrorMediaUrls =
        params.ctx.mirror.mediaUrls ??
        params.mediaUrls ??
        (params.mediaUrl ? [params.mediaUrl] : undefined);
      await appendAssistantMessageToSessionTranscript({
        agentId: params.ctx.mirror.agentId,
        idempotencyKey: params.ctx.mirror.idempotencyKey,
        mediaUrls: mirrorMediaUrls,
        sessionKey: params.ctx.mirror.sessionKey,
        text: mirrorText,
      });
    },
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  throwIfAborted(params.ctx.abortSignal);
  const result: MessageSendResult = await sendMessage({
    abortSignal: params.ctx.abortSignal,
    accountId: params.ctx.accountId ?? undefined,
    agentId: params.ctx.agentId,
    bestEffort: params.bestEffort ?? undefined,
    cfg: params.ctx.cfg,
    channel: params.ctx.channel || undefined,
    content: params.message,
    deps: params.ctx.deps,
    dryRun: params.ctx.dryRun,
    forceDocument: params.forceDocument,
    gateway: params.ctx.gateway,
    gifPlayback: params.gifPlayback,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    mirror: params.ctx.mirror,
    replyToId: params.replyToId,
    silent: params.ctx.silent,
    threadId: params.threadId,
    to: params.to,
  });

  return {
    handledBy: "core",
    payload: result,
    sendResult: result,
  };
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  resolveCorePoll: () => {
    to: string;
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number;
    durationHours?: number;
    threadId?: string;
    isAnonymous?: boolean;
  };
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  const pluginHandled = await tryHandleWithPluginAction({
    action: "poll",
    ctx: params.ctx,
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  const corePoll = params.resolveCorePoll();
  const result: MessagePollResult = await sendPoll({
    accountId: params.ctx.accountId ?? undefined,
    cfg: params.ctx.cfg,
    channel: params.ctx.channel,
    dryRun: params.ctx.dryRun,
    durationHours: corePoll.durationHours ?? undefined,
    durationSeconds: corePoll.durationSeconds ?? undefined,
    gateway: params.ctx.gateway,
    isAnonymous: corePoll.isAnonymous ?? undefined,
    maxSelections: corePoll.maxSelections,
    options: corePoll.options,
    question: corePoll.question,
    silent: params.ctx.silent ?? undefined,
    threadId: corePoll.threadId ?? undefined,
    to: corePoll.to,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
