import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { GatewayClient } from "../gateway/client.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../gateway/method-scopes.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import type {
  ApprovalDecision,
  ApprovalKind,
  ChatHistoryResult,
  ClaudeChannelMode,
  ClaudePermissionRequest,
  ConversationDescriptor,
  PendingApproval,
  QueueEvent,
  SessionListResult,
  SessionMessagePayload,
  WaitFilter,
} from "./channel-shared.js";
import { matchEventFilter, normalizeApprovalId, toConversation, toText } from "./channel-shared.js";

interface PendingWaiter {
  filter: WaitFilter;
  resolve: (value: QueueEvent | null) => void;
  timeout: NodeJS.Timeout | null;
}

interface ServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

const CLAUDE_PERMISSION_REPLY_RE = /^(yes|no)\s+([a-km-z]{5})$/i;
const QUEUE_LIMIT = 1000;

export class OpenClawChannelBridge {
  private gateway: GatewayClient | null = null;
  private readonly verbose: boolean;
  private readonly claudeChannelMode: ClaudeChannelMode;
  private readonly queue: QueueEvent[] = [];
  private readonly pendingWaiters = new Set<PendingWaiter>();
  private readonly pendingClaudePermissions = new Map<string, ClaudePermissionRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private server: McpServer | null = null;
  private cursor = 0;
  private closed = false;
  private ready = false;
  private started = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;

  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly params: {
      gatewayUrl?: string;
      gatewayToken?: string;
      gatewayPassword?: string;
      claudeChannelMode: ClaudeChannelMode;
      verbose: boolean;
    },
  ) {
    this.verbose = params.verbose;
    this.claudeChannelMode = params.claudeChannelMode;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.started) {
      await this.readyPromise;
      return;
    }
    this.started = true;
    const bootstrap = await resolveGatewayClientBootstrap({
      config: this.cfg,
      env: process.env,
      explicitAuth: {
        password: this.params.gatewayPassword,
        token: this.params.gatewayToken,
      },
      gatewayUrl: this.params.gatewayUrl,
    });
    if (this.closed) {
      this.resolveReadyOnce();
      return;
    }

    this.gateway = new GatewayClient({
      clientDisplayName: "OpenClaw MCP",
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: VERSION,
      mode: GATEWAY_CLIENT_MODES.CLI,
      onClose: (code, reason) => {
        if (!this.ready && !this.closed) {
          this.rejectReadyOnce(new Error(`gateway closed before ready (${code}): ${reason}`));
        }
      },
      onConnectError: (error) => {
        this.rejectReadyOnce(error instanceof Error ? error : new Error(String(error)));
      },
      onEvent: (event) => {
        void this.handleGatewayEvent(event);
      },
      onHelloOk: () => {
        void this.handleHelloOk();
      },
      password: bootstrap.auth.password,
      scopes: [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE],
      token: bootstrap.auth.token,
      url: bootstrap.url,
    });
    this.gateway.start();
    await this.readyPromise;
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveReadyOnce();
    for (const waiter of this.pendingWaiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(null);
    }
    this.pendingWaiters.clear();
    const {gateway} = this;
    this.gateway = null;
    await gateway?.stopAndWait().catch(() => undefined);
  }

  async listConversations(params?: {
    limit?: number;
    search?: string;
    channel?: string;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
  }): Promise<ConversationDescriptor[]> {
    await this.waitUntilReady();
    const response = await this.requestGateway<SessionListResult>("sessions.list", {
      includeDerivedTitles: params?.includeDerivedTitles ?? true,
      includeLastMessage: params?.includeLastMessage ?? true,
      limit: params?.limit ?? 50,
      search: params?.search,
    });
    const requestedChannel = normalizeOptionalLowercaseString(params?.channel);
    return (response.sessions ?? [])
      .map(toConversation)
      .filter((conversation): conversation is ConversationDescriptor => Boolean(conversation))
      .filter((conversation) =>
        requestedChannel
          ? normalizeLowercaseStringOrEmpty(conversation.channel) === requestedChannel
          : true,
      );
  }

  async getConversation(sessionKey: string): Promise<ConversationDescriptor | null> {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      return null;
    }
    const conversations = await this.listConversations({ includeLastMessage: true, limit: 500 });
    return (
      conversations.find((conversation) => conversation.sessionKey === normalizedSessionKey) ?? null
    );
  }

  async readMessages(
    sessionKey: string,
    limit = 20,
  ): Promise<NonNullable<ChatHistoryResult["messages"]>> {
    await this.waitUntilReady();
    const response = await this.requestGateway<ChatHistoryResult>("chat.history", {
      limit,
      sessionKey,
    });
    return response.messages ?? [];
  }

  async sendMessage(params: {
    sessionKey: string;
    text: string;
  }): Promise<Record<string, unknown>> {
    const conversation = await this.getConversation(params.sessionKey);
    if (!conversation) {
      throw new Error(`Conversation not found for session ${params.sessionKey}`);
    }
    return await this.requestGateway("send", {
      accountId: conversation.accountId,
      channel: conversation.channel,
      idempotencyKey: randomUUID(),
      message: params.text,
      sessionKey: conversation.sessionKey,
      threadId: conversation.threadId == null ? undefined : String(conversation.threadId),
      to: conversation.to,
    });
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].toSorted((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  }

  async respondToApproval(params: {
    kind: ApprovalKind;
    id: string;
    decision: ApprovalDecision;
  }): Promise<Record<string, unknown>> {
    if (params.kind === "exec") {
      return await this.requestGateway("exec.approval.resolve", {
        decision: params.decision,
        id: params.id,
      });
    }
    return await this.requestGateway("plugin.approval.resolve", {
      decision: params.decision,
      id: params.id,
    });
  }

  pollEvents(filter: WaitFilter, limit = 20): { events: QueueEvent[]; nextCursor: number } {
    const events = this.queue.filter((event) => matchEventFilter(event, filter)).slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? filter.afterCursor;
    return { events, nextCursor };
  }

  async waitForEvent(filter: WaitFilter, timeoutMs = 30_000): Promise<QueueEvent | null> {
    const existing = this.queue.find((event) => matchEventFilter(event, filter));
    if (existing) {
      return existing;
    }
    return await new Promise<QueueEvent | null>((resolve) => {
      const waiter: PendingWaiter = {
        filter,
        resolve: (value) => {
          this.pendingWaiters.delete(waiter);
          resolve(value);
        },
        timeout: null,
      };
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiter.resolve(null);
        }, timeoutMs);
      }
      this.pendingWaiters.add(waiter);
    });
  }

  async handleClaudePermissionRequest(params: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): Promise<void> {
    this.pendingClaudePermissions.set(params.requestId, {
      description: params.description,
      inputPreview: params.inputPreview,
      toolName: params.toolName,
    });
    this.enqueue({
      cursor: this.nextCursor(),
      description: params.description,
      inputPreview: params.inputPreview,
      requestId: params.requestId,
      toolName: params.toolName,
      type: "claude_permission_request",
    });
    if (this.verbose) {
      process.stderr.write(`openclaw mcp: pending Claude permission ${params.requestId}\n`);
    }
  }

  private async requestGateway<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.gateway) {
      throw new Error("Gateway client is not ready");
    }
    return await this.gateway.request<T>(method, params);
  }

  private async sendNotification(notification: ServerNotification): Promise<void> {
    if (!this.server || this.closed) {
      return;
    }
    try {
      await this.server.server.notification(notification);
    } catch (error) {
      if (this.verbose && !this.closed) {
        process.stderr.write(
          `openclaw mcp: notification ${notification.method} failed: ${String(error)}\n`,
        );
      }
    }
  }

  private async handleHelloOk(): Promise<void> {
    try {
      await this.requestGateway("sessions.subscribe", {});
      this.ready = true;
      this.resolveReadyOnce();
    } catch (error) {
      this.rejectReadyOnce(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectReadyOnce(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(error);
  }

  private nextCursor(): number {
    this.cursor += 1;
    return this.cursor;
  }

  private enqueue(event: QueueEvent): void {
    this.queue.push(event);
    while (this.queue.length > QUEUE_LIMIT) {
      this.queue.shift();
    }
    for (const waiter of this.pendingWaiters) {
      if (!matchEventFilter(event, waiter.filter)) {
        continue;
      }
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(event);
    }
  }

  private trackApproval(kind: ApprovalKind, payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (!id) {
      return;
    }
    this.pendingApprovals.set(id, {
      createdAtMs: typeof payload.createdAtMs === "number" ? payload.createdAtMs : undefined,
      expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : undefined,
      id,
      kind,
      request:
        payload.request && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : undefined,
    });
  }

  private resolveTrackedApproval(payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (id) {
      this.pendingApprovals.delete(id);
    }
  }

  private async handleGatewayEvent(event: EventFrame): Promise<void> {
    switch (event.event) {
      case "session.message": {
        await this.handleSessionMessageEvent(event.payload as SessionMessagePayload);
        return;
      }
      case "exec.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("exec", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          raw,
          type: "exec_approval_requested",
        });
        return;
      }
      case "exec.approval.resolved": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.resolveTrackedApproval(raw);
        this.enqueue({
          cursor: this.nextCursor(),
          raw,
          type: "exec_approval_resolved",
        });
        return;
      }
      case "plugin.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("plugin", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          raw,
          type: "plugin_approval_requested",
        });
        return;
      }
      case "plugin.approval.resolved": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.resolveTrackedApproval(raw);
        this.enqueue({
          cursor: this.nextCursor(),
          raw,
          type: "plugin_approval_resolved",
        });
      }
    }
  }

  private async handleSessionMessageEvent(payload: SessionMessagePayload): Promise<void> {
    const sessionKey = toText(payload.sessionKey);
    if (!sessionKey) {
      return;
    }
    const conversation =
      toConversation({
        key: sessionKey,
        lastAccountId: toText(payload.lastAccountId),
        lastChannel: toText(payload.lastChannel),
        lastThreadId: payload.lastThreadId,
        lastTo: toText(payload.lastTo),
      }) ?? undefined;
    const role = toText(payload.message?.role);
    const text = extractFirstTextBlock(payload.message);
    const permissionMatch = text ? CLAUDE_PERMISSION_REPLY_RE.exec(text) : null;
    if (permissionMatch) {
      const requestId = normalizeOptionalLowercaseString(permissionMatch[2]);
      if (requestId && this.pendingClaudePermissions.has(requestId)) {
        this.pendingClaudePermissions.delete(requestId);
        await this.sendNotification({
          method: "notifications/claude/channel/permission",
          params: {
            behavior: normalizeLowercaseStringOrEmpty(permissionMatch[1]).startsWith("y")
              ? "allow"
              : "deny",
            request_id: requestId,
          },
        });
        return;
      }
    }

    this.enqueue({
      conversation,
      cursor: this.nextCursor(),
      messageId: toText(payload.messageId),
      messageSeq: typeof payload.messageSeq === "number" ? payload.messageSeq : undefined,
      raw: payload,
      role,
      sessionKey,
      text,
      type: "message",
    });

    if (!this.shouldEmitClaudeChannel(role, conversation)) {
      return;
    }
    await this.sendNotification({
      method: "notifications/claude/channel",
      params: {
        content: text ?? "[non-text message]",
        meta: {
          account_id: conversation?.accountId ?? "",
          channel: conversation?.channel ?? "",
          message_id: toText(payload.messageId) ?? "",
          session_key: sessionKey,
          thread_id: conversation?.threadId == null ? "" : String(conversation.threadId),
          to: conversation?.to ?? "",
        },
      },
    });
  }

  private shouldEmitClaudeChannel(
    role: string | undefined,
    conversation: ConversationDescriptor | undefined,
  ): boolean {
    if (this.claudeChannelMode === "off") {
      return false;
    }
    if (role !== "user") {
      return false;
    }
    return Boolean(conversation);
  }
}
