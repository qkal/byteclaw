import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMemberChannelEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleMemberChannelEvent = async (params: {
    verb: "joined" | "left";
    event: SlackMemberChannelEvent;
    body: unknown;
  }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(params.body)) {
        return;
      }
      trackEvent?.();
      const payload = params.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        channelId,
        channelType,
        ctx,
        eventKind: `member-${params.verb}`,
        senderId: payload.user,
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      enqueueSystemEvent(`Slack: ${userLabel} ${params.verb} ${ingressContext.channelLabel}.`, {
        contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        sessionKey: ingressContext.sessionKey,
      });
    } catch (error) {
      ctx.runtime.error?.(danger(`slack ${params.verb} handler failed: ${String(error)}`));
    }
  };

  ctx.app.event(
    "member_joined_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      await handleMemberChannelEvent({
        body,
        event: event as SlackMemberChannelEvent,
        verb: "joined",
      });
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      await handleMemberChannelEvent({
        body,
        event: event as SlackMemberChannelEvent,
        verb: "left",
      });
    },
  );
}
