import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import { loadConfig, writeConfigFile } from "openclaw/plugin-sdk/config-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { migrateSlackChannelConfig } from "../../channel-migration.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type {
  SlackChannelCreatedEvent,
  SlackChannelIdChangedEvent,
  SlackChannelRenamedEvent,
} from "../types.js";

export function registerSlackChannelEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const enqueueChannelSystemEvent = (params: {
    kind: "created" | "renamed";
    channelId: string | undefined;
    channelName: string | undefined;
  }) => {
    if (
      !ctx.isChannelAllowed({
        channelId: params.channelId,
        channelName: params.channelName,
        channelType: "channel",
      })
    ) {
      return;
    }

    const label = resolveSlackChannelLabel({
      channelId: params.channelId,
      channelName: params.channelName,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId: params.channelId,
      channelType: "channel",
    });
    enqueueSystemEvent(`Slack channel ${params.kind}: ${label}.`, {
      contextKey: `slack:channel:${params.kind}:${params.channelId ?? params.channelName ?? "unknown"}`,
      sessionKey,
    });
  };

  ctx.app.event(
    "channel_created",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_created">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelCreatedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name;
        enqueueChannelSystemEvent({ channelId, channelName, kind: "created" });
      } catch (error) {
        ctx.runtime.error?.(danger(`slack channel created handler failed: ${String(error)}`));
      }
    },
  );

  ctx.app.event(
    "channel_rename",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_rename">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelRenamedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name_normalized ?? payload.channel?.name;
        enqueueChannelSystemEvent({ channelId, channelName, kind: "renamed" });
      } catch (error) {
        ctx.runtime.error?.(danger(`slack channel rename handler failed: ${String(error)}`));
      }
    },
  );

  ctx.app.event(
    "channel_id_changed",
    async ({ event, body }: SlackEventMiddlewareArgs<"channel_id_changed">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelIdChangedEvent;
        const oldChannelId = payload.old_channel_id;
        const newChannelId = payload.new_channel_id;
        if (!oldChannelId || !newChannelId) {
          return;
        }

        const channelInfo = await ctx.resolveChannelName(newChannelId);
        const label = resolveSlackChannelLabel({
          channelId: newChannelId,
          channelName: channelInfo?.name,
        });

        ctx.runtime.log?.(
          warn(`[slack] Channel ID changed: ${oldChannelId} → ${newChannelId} (${label})`),
        );

        if (
          !resolveChannelConfigWrites({
            accountId: ctx.accountId,
            cfg: ctx.cfg,
            channelId: "slack",
          })
        ) {
          ctx.runtime.log?.(
            warn("[slack] Config writes disabled; skipping channel config migration."),
          );
          return;
        }

        const currentConfig = loadConfig();
        const migration = migrateSlackChannelConfig({
          accountId: ctx.accountId,
          cfg: currentConfig,
          newChannelId,
          oldChannelId,
        });

        if (migration.migrated) {
          migrateSlackChannelConfig({
            accountId: ctx.accountId,
            cfg: ctx.cfg,
            newChannelId,
            oldChannelId,
          });
          await writeConfigFile(currentConfig);
          ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
        } else if (migration.skippedExisting) {
          ctx.runtime.log?.(
            warn(
              `[slack] Channel config already exists for ${newChannelId}; leaving ${oldChannelId} unchanged`,
            ),
          );
        } else {
          ctx.runtime.log?.(
            warn(
              `[slack] No config found for old channel ID ${oldChannelId}; migration logged only`,
            ),
          );
        }
      } catch (error) {
        ctx.runtime.error?.(danger(`slack channel_id_changed handler failed: ${String(error)}`));
      }
    },
  );
}
