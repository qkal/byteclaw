import { readStringParam } from "../../agents/tools/common.js";
import type {
  ChannelId,
  ChannelThreadingAdapter,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  OutboundSessionRoute,
  ResolveOutboundSessionRouteParams,
} from "./outbound-session.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

type ResolveAutoThreadId = NonNullable<ChannelThreadingAdapter["resolveAutoThreadId"]>;

export function resolveAndApplyOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    toolContext?: ChannelThreadingToolContext;
    resolveAutoThreadId?: ResolveAutoThreadId;
  },
): string | undefined {
  const threadId = readStringParam(actionParams, "threadId");
  const resolved =
    threadId ??
    context.resolveAutoThreadId?.({
      accountId: context.accountId,
      cfg: context.cfg,
      replyToId: readStringParam(actionParams, "replyTo"),
      to: context.to,
      toolContext: context.toolContext,
    });
  if (resolved && !actionParams.threadId) {
    actionParams.threadId = resolved;
  }
  return resolved ?? undefined;
}

export async function prepareOutboundMirrorRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  to: string;
  actionParams: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  agentId?: string;
  currentSessionKey?: string;
  dryRun?: boolean;
  resolvedTarget?: ResolvedMessagingTarget;
  resolveAutoThreadId?: ResolveAutoThreadId;
  resolveOutboundSessionRoute: (
    params: ResolveOutboundSessionRouteParams,
  ) => Promise<OutboundSessionRoute | null>;
  ensureOutboundSessionEntry: (params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    accountId?: string | null;
    route: OutboundSessionRoute;
  }) => Promise<void>;
}): Promise<{
  resolvedThreadId?: string;
  outboundRoute: OutboundSessionRoute | null;
}> {
  const replyToId = readStringParam(params.actionParams, "replyTo");
  const resolvedThreadId = resolveAndApplyOutboundThreadId(params.actionParams, {
    accountId: params.accountId,
    cfg: params.cfg,
    resolveAutoThreadId: params.resolveAutoThreadId,
    to: params.to,
    toolContext: params.toolContext,
  });
  const outboundRoute =
    params.agentId && !params.dryRun
      ? await params.resolveOutboundSessionRoute({
          accountId: params.accountId,
          agentId: params.agentId,
          cfg: params.cfg,
          channel: params.channel,
          currentSessionKey: params.currentSessionKey,
          replyToId,
          resolvedTarget: params.resolvedTarget,
          target: params.to,
          threadId: resolvedThreadId,
        })
      : null;
  if (outboundRoute && params.agentId && !params.dryRun) {
    await params.ensureOutboundSessionEntry({
      accountId: params.accountId,
      cfg: params.cfg,
      channel: params.channel,
      route: outboundRoute,
    });
  }
  if (outboundRoute && !params.dryRun) {
    params.actionParams.__sessionKey = outboundRoute.sessionKey;
  }
  if (params.agentId) {
    params.actionParams.__agentId = params.agentId;
  }
  return {
    outboundRoute,
    resolvedThreadId,
  };
}
