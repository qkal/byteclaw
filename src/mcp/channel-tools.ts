import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpenClawChannelBridge } from "./channel-bridge.js";
import {
  extractAttachmentsFromMessage,
  resolveMessageId,
  summarizeResult,
  toText,
} from "./channel-shared.js";

export function getChannelMcpCapabilities(claudeChannelMode: "off" | "on" | "auto") {
  if (claudeChannelMode === "off") {
    return undefined;
  }
  return {
    experimental: {
      "claude/channel": {},
      "claude/channel/permission": {},
    },
  };
}

export function registerChannelMcpTools(server: McpServer, bridge: OpenClawChannelBridge): void {
  server.tool(
    "conversations_list",
    "List OpenClaw channel-backed conversations available through session routes.",
    {
      channel: z.string().optional(),
      includeDerivedTitles: z.boolean().optional(),
      includeLastMessage: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      search: z.string().optional(),
    },
    async (args) => {
      const conversations = await bridge.listConversations(args);
      return {
        ...summarizeResult("conversations", conversations.length),
        structuredContent: { conversations },
      };
    },
  );

  server.tool(
    "conversation_get",
    "Get one OpenClaw conversation by session key.",
    { session_key: z.string().min(1) },
    async ({ session_key }) => {
      const conversation = await bridge.getConversation(session_key);
      if (!conversation) {
        return {
          content: [{ text: `conversation not found: ${session_key}`, type: "text" }],
          isError: true,
        };
      }
      return {
        content: [{ text: `conversation ${conversation.sessionKey}`, type: "text" }],
        structuredContent: { conversation },
      };
    },
  );

  server.tool(
    "messages_read",
    "Read recent messages for one OpenClaw conversation.",
    {
      limit: z.number().int().min(1).max(200).optional(),
      session_key: z.string().min(1),
    },
    async ({ session_key, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 20);
      return {
        ...summarizeResult("messages", messages.length),
        structuredContent: { messages },
      };
    },
  );

  server.tool(
    "attachments_fetch",
    "List non-text attachments for a message in one OpenClaw conversation.",
    {
      limit: z.number().int().min(1).max(200).optional(),
      message_id: z.string().min(1),
      session_key: z.string().min(1),
    },
    async ({ session_key, message_id, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 100);
      const message = messages.find((entry) => resolveMessageId(entry) === message_id);
      if (!message) {
        return {
          content: [{ text: `message not found: ${message_id}`, type: "text" }],
          isError: true,
        };
      }
      const attachments = extractAttachmentsFromMessage(message);
      return {
        ...summarizeResult("attachments", attachments.length),
        structuredContent: { attachments, message },
      };
    },
  );

  server.tool(
    "events_poll",
    "Poll queued OpenClaw conversation events since a cursor.",
    {
      after_cursor: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      session_key: z.string().optional(),
    },
    async ({ after_cursor, session_key, limit }) => {
      const { events, nextCursor } = bridge.pollEvents(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        limit ?? 20,
      );
      return {
        ...summarizeResult("events", events.length),
        structuredContent: { events, next_cursor: nextCursor },
      };
    },
  );

  server.tool(
    "events_wait",
    "Wait for the next queued OpenClaw conversation event.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      timeout_ms: z.number().int().min(1).max(300_000).optional(),
    },
    async ({ after_cursor, session_key, timeout_ms }) => {
      const event = await bridge.waitForEvent(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        timeout_ms ?? 30_000,
      );
      return {
        content: [{ text: event ? `event ${event.cursor}` : "timeout", type: "text" }],
        structuredContent: { event },
      };
    },
  );

  server.tool(
    "messages_send",
    "Send a message back through the same OpenClaw conversation route.",
    {
      session_key: z.string().min(1),
      text: z.string().min(1),
    },
    async ({ session_key, text }) => {
      const result = await bridge.sendMessage({ sessionKey: session_key, text });
      return {
        content: [{ text: "sent", type: "text" }],
        structuredContent: { result },
      };
    },
  );

  server.tool(
    "permissions_list_open",
    "List open OpenClaw exec or plugin approval requests visible through the Gateway.",
    {},
    async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        ...summarizeResult("approvals", approvals.length),
        structuredContent: { approvals },
      };
    },
  );

  server.tool(
    "permissions_respond",
    "Allow or deny one pending OpenClaw exec or plugin approval request.",
    {
      decision: z.enum(["allow-once", "allow-always", "deny"]),
      id: z.string().min(1),
      kind: z.enum(["exec", "plugin"]),
    },
    async ({ kind, id, decision }) => {
      const result = await bridge.respondToApproval({ decision, id, kind });
      return {
        content: [{ text: "approval resolved", type: "text" }],
        structuredContent: { result },
      };
    },
  );
}
