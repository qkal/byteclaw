import { z } from "zod";
import { normalizeOptionalString as toText } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export type ClaudeChannelMode = "off" | "on" | "auto";

export interface ConversationDescriptor {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
}

export interface SessionRow {
  key: string;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
}

export interface SessionListResult {
  sessions?: SessionRow[];
}

export interface ChatHistoryResult {
  messages?: { id?: string; role?: string; content?: unknown; [key: string]: unknown }[];
}

export interface SessionMessagePayload {
  sessionKey?: string;
  messageId?: string;
  messageSeq?: number;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  [key: string]: unknown;
}

export type ApprovalKind = "exec" | "plugin";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface PendingApproval {
  kind: ApprovalKind;
  id: string;
  request?: Record<string, unknown>;
  createdAtMs?: number;
  expiresAtMs?: number;
}

export type QueueEvent =
  | {
      cursor: number;
      type: "message";
      sessionKey: string;
      conversation?: ConversationDescriptor;
      messageId?: string;
      messageSeq?: number;
      role?: string;
      text?: string;
      raw: SessionMessagePayload;
    }
  | {
      cursor: number;
      type: "claude_permission_request";
      requestId: string;
      toolName: string;
      description: string;
      inputPreview: string;
    }
  | {
      cursor: number;
      type: "exec_approval_requested" | "exec_approval_resolved";
      raw: Record<string, unknown>;
    }
  | {
      cursor: number;
      type: "plugin_approval_requested" | "plugin_approval_resolved";
      raw: Record<string, unknown>;
    };

export interface ClaudePermissionRequest {
  toolName: string;
  description: string;
  inputPreview: string;
}

export interface WaitFilter {
  afterCursor: number;
  sessionKey?: string;
}

export const ClaudePermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    description: z.string(),
    input_preview: z.string(),
    request_id: z.string(),
    tool_name: z.string(),
  }),
});

export { toText };

export function resolveMessageId(entry: Record<string, unknown>): string | undefined {
  return (
    toText(entry.id) ??
    (entry.__openclaw && typeof entry.__openclaw === "object"
      ? toText((entry.__openclaw as { id?: unknown }).id)
      : undefined)
  );
}

export function summarizeResult(
  label: string,
  count: number,
): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ text: `${label}: ${count}`, type: "text" }],
  };
}

export function resolveConversationChannel(row: SessionRow): string | undefined {
  return normalizeMessageChannel(
    toText(row.deliveryContext?.channel) ??
      toText(row.lastChannel) ??
      toText(row.channel) ??
      toText(row.origin?.provider),
  );
}

export function toConversation(row: SessionRow): ConversationDescriptor | null {
  const channel = resolveConversationChannel(row);
  const to = toText(row.deliveryContext?.to) ?? toText(row.lastTo);
  if (!channel || !to) {
    return null;
  }
  return {
    accountId:
      toText(row.deliveryContext?.accountId) ??
      toText(row.lastAccountId) ??
      toText(row.origin?.accountId),
    channel,
    derivedTitle: toText(row.derivedTitle),
    displayName: toText(row.displayName),
    label: toText(row.label),
    lastMessagePreview: toText(row.lastMessagePreview),
    sessionKey: row.key,
    threadId: row.deliveryContext?.threadId ?? row.lastThreadId ?? row.origin?.threadId,
    to,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

export function matchEventFilter(event: QueueEvent, filter: WaitFilter): boolean {
  if (event.cursor <= filter.afterCursor) {
    return false;
  }
  if (!filter.sessionKey) {
    return true;
  }
  return "sessionKey" in event && event.sessionKey === filter.sessionKey;
}

export function extractAttachmentsFromMessage(message: unknown): unknown[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const { content } = message as { content?: unknown };
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return toText((entry as { type?: unknown }).type) !== "text";
  });
}

export function normalizeApprovalId(value: unknown): string | undefined {
  const id = toText(value);
  return id ? id.trim() : undefined;
}
