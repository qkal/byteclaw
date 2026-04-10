import type { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import type {
  ChannelApprovalCapabilityHandlerContext,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ExecApprovalRequest,
  buildApprovalInteractiveReplyFromActionDescriptors,
} from "openclaw/plugin-sdk/infra-runtime";
import { logError, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  isSlackExecApprovalClientEnabled,
  normalizeSlackApproverId,
  shouldHandleSlackExecApprovalRequest,
} from "./exec-approvals.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { sendMessageSlack } from "./send.js";

type SlackBlock = Block | KnownBlock;
interface SlackPendingApproval {
  channelId: string;
  messageTs: string;
}
interface SlackPendingDelivery {
  text: string;
  blocks: SlackBlock[];
}

type SlackExecApprovalConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"]
>;

export interface SlackApprovalHandlerContext {
  app: App;
  config: SlackExecApprovalConfig;
}

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: SlackApprovalHandlerContext;
} | null {
  const context = params.context as SlackApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.app || !accountId) {
    return null;
  }
  return { accountId, context };
}

function truncateSlackMrkdwn(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function buildSlackCodeBlock(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return `${fence}\n${text}\n${fence}`;
}

function formatSlackApprover(resolvedBy?: string | null): string | null {
  const normalized = resolvedBy ? normalizeSlackApproverId(resolvedBy) : undefined;
  if (normalized) {
    return `<@${normalized}>`;
  }
  const trimmed = normalizeOptionalString(resolvedBy);
  return trimmed ? trimmed : null;
}

function formatSlackMetadataLine(label: string, value: string): string {
  return `*${label}:* ${value}`;
}

function buildSlackMetadataLines(metadata: readonly { label: string; value: string }[]): string[] {
  return metadata.map((item) => formatSlackMetadataLine(item.label, item.value));
}

function resolveSlackApprovalDecisionLabel(
  decision: "allow-once" | "allow-always" | "deny",
): string {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function buildSlackPendingApprovalText(view: ExecApprovalPendingView): string {
  const metadataLines = buildSlackMetadataLines(view.metadata);
  const lines = [
    "*Exec approval required*",
    "A command needs your approval.",
    "",
    "*Command*",
    buildSlackCodeBlock(view.commandText),
    ...metadataLines,
  ];
  return lines.filter(Boolean).join("\n");
}

function buildSlackPendingApprovalBlocks(view: ExecApprovalPendingView): SlackBlock[] {
  const metadataLines = buildSlackMetadataLines(view.metadata);
  const interactiveBlocks =
    resolveSlackReplyBlocks({
      interactive: buildApprovalInteractiveReplyFromActionDescriptors(view.actions),
      text: "",
    }) ?? [];
  return [
    {
      text: {
        text: "*Exec approval required*\nA command needs your approval.",
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
        type: "mrkdwn",
      },
      type: "section",
    },
    ...(metadataLines.length > 0
      ? [
          {
            elements: metadataLines.map((line) => ({
              text: line,
              type: "mrkdwn" as const,
            })),
            type: "context",
          } satisfies SlackBlock,
        ]
      : []),
    ...interactiveBlocks,
  ];
}

function buildSlackResolvedText(view: ExecApprovalResolvedView): string {
  const resolvedBy = formatSlackApprover(view.resolvedBy);
  const lines = [
    `*Exec approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*`,
    resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved.",
    "",
    "*Command*",
    buildSlackCodeBlock(view.commandText),
  ];
  return lines.join("\n");
}

function buildSlackResolvedBlocks(view: ExecApprovalResolvedView): SlackBlock[] {
  const resolvedBy = formatSlackApprover(view.resolvedBy);
  return [
    {
      text: {
        text: `*Exec approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*\n${
          resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved."
        }`,
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

function buildSlackExpiredText(view: ExecApprovalExpiredView): string {
  return [
    "*Exec approval expired*",
    "This approval request expired before it was resolved.",
    "",
    "*Command*",
    buildSlackCodeBlock(view.commandText),
  ].join("\n");
}

function buildSlackExpiredBlocks(view: ExecApprovalExpiredView): SlackBlock[] {
  return [
    {
      text: {
        text: "*Exec approval expired*\nThis approval request expired before it was resolved.",
        type: "mrkdwn",
      },
      type: "section",
    },
    {
      text: {
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
        type: "mrkdwn",
      },
      type: "section",
    },
  ];
}

async function updateMessage(params: {
  app: App;
  channelId: string;
  messageTs: string;
  text: string;
  blocks: SlackBlock[];
}): Promise<void> {
  try {
    await params.app.client.chat.update({
      blocks: params.blocks,
      channel: params.channelId,
      text: params.text,
      ts: params.messageTs,
    });
  } catch (error) {
    logError(`slack exec approvals: failed to update message: ${String(error)}`);
  }
}

export const slackApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  SlackPendingDelivery,
  { to: string; threadTs?: string },
  SlackPendingApproval,
  never,
  SlackPendingDelivery
>({
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isSlackExecApprovalClientEnabled({
            accountId: resolved.accountId,
            cfg: params.cfg,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      if (!resolved) {
        return false;
      }
      return shouldHandleSlackExecApprovalRequest({
        accountId: resolved.accountId,
        cfg: params.cfg,
        request: params.request as ExecApprovalRequest,
      });
    },
  },
  eventKinds: ["exec"],
  observe: {
    onDeliveryError: ({ error, request }) => {
      logError(`slack exec approvals: failed to deliver approval ${request.id}: ${String(error)}`);
    },
  },
  presentation: {
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: {
        blocks: buildSlackExpiredBlocks(view as ExecApprovalExpiredView),
        text: buildSlackExpiredText(view as ExecApprovalExpiredView),
      },
    }),
    buildPendingPayload: ({ view }) => ({
      blocks: buildSlackPendingApprovalBlocks(view as ExecApprovalPendingView),
      text: buildSlackPendingApprovalText(view as ExecApprovalPendingView),
    }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: {
        blocks: buildSlackResolvedBlocks(view as ExecApprovalResolvedView),
        text: buildSlackResolvedText(view as ExecApprovalResolvedView),
      },
    }),
  },
  transport: {
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return null;
      }
      const message = await sendMessageSlack(preparedTarget.to, pendingPayload.text, {
        accountId: resolved.accountId,
        blocks: pendingPayload.blocks,
        cfg,
        client: resolved.context.app.client,
        threadTs: preparedTarget.threadTs,
      });
      return {
        channelId: message.channelId,
        messageTs: message.messageId,
      };
    },
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: {
        threadTs:
          plannedTarget.target.threadId != null ? String(plannedTarget.target.threadId) : undefined,
        to: plannedTarget.target.to,
      },
    }),
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const resolved = resolveHandlerContext({ accountId, cfg, context });
      if (!resolved) {
        return;
      }
      const nextPayload = payload;
      await updateMessage({
        app: resolved.context.app,
        blocks: nextPayload.blocks,
        channelId: entry.channelId,
        messageTs: entry.messageTs,
        text: nextPayload.text,
      });
    },
  },
});
