import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { ContextVisibilityMode } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackAllowListMatch } from "../allow-list.js";
import { readSessionUpdatedAt } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import {
  type SlackMediaResult,
  type SlackThreadStarter,
  resolveSlackMedia,
  resolveSlackThreadHistory,
} from "../media.js";

export interface SlackThreadContextData {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  threadSessionPreviousTimestamp: number | undefined;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
}

function isSlackThreadContextSenderAllowed(params: {
  allowFromLower: string[];
  allowNameMatching: boolean;
  userId?: string;
  userName?: string;
  botId?: string;
}): boolean {
  if (params.allowFromLower.length === 0 || params.botId) {
    return true;
  }
  if (!params.userId) {
    return false;
  }
  return resolveSlackAllowListMatch({
    allowList: params.allowFromLower,
    allowNameMatching: params.allowNameMatching,
    id: params.userId,
    name: params.userName,
  }).allowed;
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  allowFromLower: string[];
  allowNameMatching: boolean;
  contextVisibilityMode: ContextVisibilityMode;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadHistoryBody,
      threadLabel,
      threadSessionPreviousTimestamp,
      threadStarterBody,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  const starterSenderName =
    params.allowNameMatching && starter?.userId
      ? (await params.ctx.resolveUserName(starter.userId))?.name
      : undefined;
  const starterAllowed =
    !starter ||
    isSlackThreadContextSenderAllowed({
      allowFromLower: params.allowFromLower,
      allowNameMatching: params.allowNameMatching,
      botId: starter.botId,
      userId: starter.userId,
      userName: starterSenderName,
    });
  const includeStarterContext =
    !starter ||
    shouldIncludeSupplementalContext({
      kind: "thread",
      mode: params.contextVisibilityMode,
      senderAllowed: starterAllowed,
    });

  if (starter?.text && includeStarterContext) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        maxBytes: params.ctx.mediaMaxBytes,
        token: params.ctx.botToken,
      });
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }
  if (starter?.text && !includeStarterContext) {
    logVerbose(
      `slack: omitted thread starter from context (mode=${params.contextVisibilityMode}, sender_allowed=${starterAllowed ? "yes" : "no"})`,
    );
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
  threadSessionPreviousTimestamp = readSessionUpdatedAt({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });

  if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
      threadTs: params.threadTs,
    });

    if (threadHistory.length > 0) {
      const uniqueUserIds = [
        ...new Set(
          threadHistory.map((item) => item.userId).filter((id): id is string => Boolean(id)),
        ),
      ];
      const userMap = new Map<string, { name?: string }>();
      await Promise.all(
        uniqueUserIds.map(async (id) => {
          const user = await params.ctx.resolveUserName(id);
          if (user) {
            userMap.set(id, user);
          }
        }),
      );

      const { items: filteredThreadHistory, omitted: omittedHistoryCount } =
        filterSupplementalContextItems({
          isSenderAllowed: (historyMsg) => {
            const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
            return isSlackThreadContextSenderAllowed({
              allowFromLower: params.allowFromLower,
              allowNameMatching: params.allowNameMatching,
              botId: historyMsg.botId,
              userId: historyMsg.userId,
              userName: msgUser?.name,
            });
          },
          items: threadHistory,
          kind: "thread",
          mode: params.contextVisibilityMode,
        });
      if (omittedHistoryCount > 0) {
        logVerbose(
          `slack: omitted ${omittedHistoryCount} thread message(s) from context (mode=${params.contextVisibilityMode})`,
        );
      }

      const historyParts: string[] = [];
      for (const historyMsg of filteredThreadHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const msgSenderName =
          msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
        const isBot = Boolean(historyMsg.botId);
        const role = isBot ? "assistant" : "user";
        const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            body: msgWithId,
            channel: "Slack",
            chatType: "channel",
            envelope: params.envelopeOptions,
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
          }),
        );
      }
      if (historyParts.length > 0) {
        threadHistoryBody = historyParts.join("\n\n");
        logVerbose(
          `slack: populated thread history with ${filteredThreadHistory.length} messages for new session`,
        );
      }
    }
  }

  return {
    threadHistoryBody,
    threadLabel,
    threadSessionPreviousTimestamp,
    threadStarterBody,
    threadStarterMedia,
  };
}
