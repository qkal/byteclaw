import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { listThinkingLevels } from "../auto-reply/thinking.js";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.js";
import {
  type FixedWindowRateLimiter,
  createFixedWindowRateLimiter,
} from "../infra/fixed-window-rate-limit.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { shortenHomePath } from "../utils.js";
import { getAvailableCommands } from "./commands.js";
import {
  extractAttachmentsFromPrompt,
  extractTextFromPrompt,
  extractToolCallContent,
  extractToolCallLocations,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
import { readBool, readNumber, readString } from "./meta.js";
import { parseSessionMeta, resetSessionIfNeeded, resolveSessionKey } from "./session-mapper.js";
import { type AcpSessionStore, defaultAcpSessionStore } from "./session.js";
import { ACP_AGENT_INFO, type AcpServerOptions } from "./types.js";

// Maximum allowed prompt size (2MB) to prevent DoS via memory exhaustion (CWE-400, GHSA-cxpw-2g23-2vgw)
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const ACP_FAST_MODE_CONFIG_ID = "fast_mode";
const ACP_VERBOSE_LEVEL_CONFIG_ID = "verbose_level";
const ACP_REASONING_LEVEL_CONFIG_ID = "reasoning_level";
const ACP_RESPONSE_USAGE_CONFIG_ID = "response_usage";
const ACP_ELEVATED_LEVEL_CONFIG_ID = "elevated_level";
const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;
const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5000;

interface DisconnectContext {
  generation: number;
  reason: string;
}

interface PendingPrompt {
  sessionId: string;
  sessionKey: string;
  idempotencyKey: string;
  sendAccepted?: boolean;
  disconnectContext?: DisconnectContext;
  resolve: (response: PromptResponse) => void;
  reject: (err: Error) => void;
  sentTextLength?: number;
  sentText?: string;
  sentThoughtLength?: number;
  sentThought?: string;
  toolCalls?: Map<string, PendingToolCall>;
}

interface PendingToolCall {
  kind: ToolKind;
  locations?: ToolCallLocation[];
  rawInput?: Record<string, unknown>;
  title: string;
}

type AcpGatewayAgentOptions = AcpServerOptions & {
  sessionStore?: AcpSessionStore;
};

type GatewaySessionPresentationRow = Pick<
  GatewaySessionRow,
  | "displayName"
  | "label"
  | "derivedTitle"
  | "updatedAt"
  | "thinkingLevel"
  | "fastMode"
  | "modelProvider"
  | "model"
  | "verboseLevel"
  | "reasoningLevel"
  | "responseUsage"
  | "elevatedLevel"
  | "totalTokens"
  | "totalTokensFresh"
  | "contextTokens"
>;

interface SessionPresentation {
  configOptions: SessionConfigOption[];
  modes: SessionModeState;
}

interface SessionMetadata {
  title?: string | null;
  updatedAt?: string | null;
}

interface SessionUsageSnapshot {
  size: number;
  used: number;
}

function isAdminScopeProvenanceRejection(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode =
    typeof (err as { gatewayCode?: unknown }).gatewayCode === "string"
      ? (err as { gatewayCode?: string }).gatewayCode
      : undefined;
  return (
    err.name === "GatewayClientRequestError" &&
    gatewayCode === "INVALID_REQUEST" &&
    err.message.includes("system provenance fields require admin scope")
  );
}

function isGatewayCloseError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("gateway closed (");
}

type SessionSnapshot = SessionPresentation & {
  metadata?: SessionMetadata;
  usage?: SessionUsageSnapshot;
};

interface AgentWaitResult {
  status?: "ok" | "error" | "timeout";
  error?: string;
}

interface GatewayTranscriptMessage {
  role?: unknown;
  content?: unknown;
}

interface GatewayChatContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface ReplayChunk {
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
  text: string;
}

const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

function formatThinkingLevelName(level: string): string {
  switch (level) {
    case "xhigh": {
      return "Extra High";
    }
    case "adaptive": {
      return "Adaptive";
    }
    default: {
      return level.length > 0 ? `${level[0].toUpperCase()}${level.slice(1)}` : "Unknown";
    }
  }
}

function buildThinkingModeDescription(level: string): string | undefined {
  if (level === "adaptive") {
    return "Use the Gateway session default thought level.";
  }
  return undefined;
}

function formatConfigValueName(value: string): string {
  switch (value) {
    case "xhigh": {
      return "Extra High";
    }
    default: {
      return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : "Unknown";
    }
  }
}

function buildSelectConfigOption(params: {
  id: string;
  name: string;
  description: string;
  currentValue: string;
  values: readonly string[];
  category?: string;
}): SessionConfigOption {
  return {
    category: params.category,
    currentValue: params.currentValue,
    description: params.description,
    id: params.id,
    name: params.name,
    options: params.values.map((value) => ({
      name: formatConfigValueName(value),
      value,
    })),
    type: "select",
  };
}

function buildSessionPresentation(params: {
  row?: GatewaySessionPresentationRow;
  overrides?: Partial<GatewaySessionPresentationRow>;
}): SessionPresentation {
  const row = {
    ...params.row,
    ...params.overrides,
  };
  const availableLevelIds: string[] = [...listThinkingLevels(row.modelProvider, row.model)];
  const currentModeId = normalizeOptionalString(row.thinkingLevel) || "adaptive";
  if (!availableLevelIds.includes(currentModeId)) {
    availableLevelIds.push(currentModeId);
  }

  const modes: SessionModeState = {
    availableModes: availableLevelIds.map((level) => ({
      description: buildThinkingModeDescription(level),
      id: level,
      name: formatThinkingLevelName(level),
    })),
    currentModeId,
  };

  const configOptions: SessionConfigOption[] = [
    buildSelectConfigOption({
      category: "thought_level",
      currentValue: currentModeId,
      description:
        "Controls how much deliberate reasoning OpenClaw requests from the Gateway model.",
      id: ACP_THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought level",
      values: availableLevelIds,
    }),
    buildSelectConfigOption({
      currentValue: row.fastMode ? "on" : "off",
      description: "Controls whether OpenAI sessions use the Gateway fast-mode profile.",
      id: ACP_FAST_MODE_CONFIG_ID,
      name: "Fast mode",
      values: ["off", "on"],
    }),
    buildSelectConfigOption({
      currentValue: normalizeOptionalString(row.verboseLevel) || "off",
      description:
        "Controls how much tool progress and output detail OpenClaw keeps enabled for the session.",
      id: ACP_VERBOSE_LEVEL_CONFIG_ID,
      name: "Tool verbosity",
      values: ["off", "on", "full"],
    }),
    buildSelectConfigOption({
      currentValue: normalizeOptionalString(row.reasoningLevel) || "off",
      description: "Controls whether reasoning-capable models emit reasoning text for the session.",
      id: ACP_REASONING_LEVEL_CONFIG_ID,
      name: "Reasoning stream",
      values: ["off", "on", "stream"],
    }),
    buildSelectConfigOption({
      currentValue: normalizeOptionalString(row.responseUsage) || "off",
      description:
        "Controls how much usage information OpenClaw attaches to responses for the session.",
      id: ACP_RESPONSE_USAGE_CONFIG_ID,
      name: "Usage detail",
      values: ["off", "tokens", "full"],
    }),
    buildSelectConfigOption({
      currentValue: normalizeOptionalString(row.elevatedLevel) || "off",
      description: "Controls how aggressively the session allows elevated execution behavior.",
      id: ACP_ELEVATED_LEVEL_CONFIG_ID,
      name: "Elevated actions",
      values: ["off", "on", "ask", "full"],
    }),
  ];

  return { configOptions, modes };
}

function extractReplayChunks(message: GatewayTranscriptMessage): ReplayChunk[] {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  if (typeof message.content === "string") {
    return message.content.length > 0
      ? [
          {
            sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
            text: message.content,
          },
        ]
      : [];
  }
  if (!Array.isArray(message.content)) {
    return [];
  }

  const replayChunks: ReplayChunk[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typedBlock = block as GatewayChatContentBlock;
    if (typedBlock.type === "text" && typeof typedBlock.text === "string" && typedBlock.text) {
      replayChunks.push({
        sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
        text: typedBlock.text,
      });
      continue;
    }
    if (
      role === "assistant" &&
      typedBlock.type === "thinking" &&
      typeof typedBlock.thinking === "string" &&
      typedBlock.thinking
    ) {
      replayChunks.push({
        sessionUpdate: "agent_thought_chunk",
        text: typedBlock.thinking,
      });
    }
  }
  return replayChunks;
}

function buildSessionMetadata(params: {
  row?: GatewaySessionPresentationRow;
  sessionKey: string;
}): SessionMetadata {
  const title =
    normalizeOptionalString(params.row?.derivedTitle) ||
    normalizeOptionalString(params.row?.displayName) ||
    normalizeOptionalString(params.row?.label) ||
    params.sessionKey;
  const updatedAt =
    typeof params.row?.updatedAt === "number" && Number.isFinite(params.row.updatedAt)
      ? new Date(params.row.updatedAt).toISOString()
      : null;
  return { title, updatedAt };
}

function buildSessionUsageSnapshot(
  row?: GatewaySessionPresentationRow,
): SessionUsageSnapshot | undefined {
  const totalTokens = row?.totalTokens;
  const contextTokens = row?.contextTokens;
  if (
    row?.totalTokensFresh !== true ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return undefined;
  }
  const size = Math.max(0, Math.floor(contextTokens));
  const used = Math.max(0, Math.min(Math.floor(totalTokens), size));
  return { size, used };
}

function buildSystemInputProvenance(originSessionId: string) {
  return {
    kind: "external_user" as const,
    originSessionId,
    sourceChannel: "acp",
    sourceTool: "openclaw_acp",
  };
}

function buildSystemProvenanceReceipt(params: {
  cwd: string;
  sessionId: string;
  sessionKey: string;
}) {
  return [
    "[Source Receipt]",
    "bridge=openclaw-acp",
    `originHost=${os.hostname()}`,
    `originCwd=${shortenHomePath(params.cwd)}`,
    `acpSessionId=${params.sessionId}`,
    `originSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}

export class AcpGatewayAgent implements Agent {
  private connection: AgentSideConnection;
  private gateway: GatewayClient;
  private opts: AcpGatewayAgentOptions;
  private log: (msg: string) => void;
  private sessionStore: AcpSessionStore;
  private sessionCreateRateLimiter: FixedWindowRateLimiter;
  private pendingPrompts = new Map<string, PendingPrompt>();
  private disconnectTimer: NodeJS.Timeout | null = null;
  private activeDisconnectContext: DisconnectContext | null = null;
  private disconnectGeneration = 0;

  private getPendingPrompt(sessionId: string, runId: string): PendingPrompt | undefined {
    const pending = this.pendingPrompts.get(sessionId);
    if (pending?.idempotencyKey !== runId) {
      return undefined;
    }
    return pending;
  }

  constructor(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpGatewayAgentOptions = {},
  ) {
    this.connection = connection;
    this.gateway = gateway;
    this.opts = opts;
    this.log = opts.verbose ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
    this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: Math.max(
        1,
        opts.sessionCreateRateLimit?.maxRequests ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
      ),
      windowMs: Math.max(
        1000,
        opts.sessionCreateRateLimit?.windowMs ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
      ),
    });
  }

  start(): void {
    this.log("ready");
  }

  handleGatewayReconnect(): void {
    this.log("gateway reconnected");
    const disconnectContext = this.activeDisconnectContext;
    this.activeDisconnectContext = null;
    if (!disconnectContext) {
      return;
    }
    void this.reconcilePendingPrompts(disconnectContext.generation, false);
  }

  handleGatewayDisconnect(reason: string): void {
    this.log(`gateway disconnected: ${reason}`);
    const disconnectContext = {
      generation: this.disconnectGeneration + 1,
      reason,
    };
    this.disconnectGeneration = disconnectContext.generation;
    this.activeDisconnectContext = disconnectContext;
    if (this.pendingPrompts.size === 0) {
      return;
    }
    for (const pending of this.pendingPrompts.values()) {
      pending.disconnectContext = disconnectContext;
    }
    this.armDisconnectTimer(disconnectContext);
  }

  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    if (evt.event === "chat") {
      await this.handleChatEvent(evt);
      return;
    }
    if (evt.event === "agent") {
      await this.handleAgentEvent(evt);
    }
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        promptCapabilities: {
          audio: false,
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: [],
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params._meta);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      fallbackKey: `acp:${sessionId}`,
      meta,
    });

    const session = this.sessionStore.createSession({
      cwd: params.cwd,
      sessionId,
      sessionKey,
    });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey);
    await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: false,
    });
    await this.sendAvailableCommands(session.sessionId);
    const { configOptions, modes } = sessionSnapshot;
    return {
      configOptions,
      modes,
      sessionId: session.sessionId,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    if (!this.sessionStore.hasSession(params.sessionId)) {
      this.enforceSessionCreateRateLimit("loadSession");
    }

    const meta = parseSessionMeta(params._meta);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      fallbackKey: params.sessionId,
      meta,
    });

    const session = this.sessionStore.createSession({
      cwd: params.cwd,
      sessionId: params.sessionId,
      sessionKey,
    });
    this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
    const [sessionSnapshot, transcript] = await Promise.all([
      this.getSessionSnapshot(session.sessionKey),
      this.getSessionTranscript(session.sessionKey).catch((error) => {
        this.log(`session transcript fallback for ${session.sessionKey}: ${String(error)}`);
        return [];
      }),
    ]);
    await this.replaySessionTranscript(session.sessionId, transcript);
    await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: false,
    });
    await this.sendAvailableCommands(session.sessionId);
    const { configOptions, modes } = sessionSnapshot;
    return { configOptions, modes };
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const limit = readNumber(params._meta, ["limit"]) ?? 100;
    const result = await this.gateway.request<SessionsListResult>("sessions.list", { limit });
    const cwd = params.cwd ?? process.cwd();
    return {
      nextCursor: null,
      sessions: result.sessions.map((session) => ({
        _meta: {
          channel: session.channel,
          kind: session.kind,
          sessionKey: session.key,
        },
        cwd,
        sessionId: session.key,
        title: session.displayName ?? session.label ?? session.key,
        updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : undefined,
      })),
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    if (!params.modeId) {
      return {};
    }
    try {
      await this.gateway.request("sessions.patch", {
        key: session.sessionKey,
        thinkingLevel: params.modeId,
      });
      this.log(`setSessionMode: ${session.sessionId} -> ${params.modeId}`);
      const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, {
        thinkingLevel: params.modeId,
      });
      await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
        includeControls: true,
      });
    } catch (error) {
      this.log(`setSessionMode error: ${String(error)}`);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    const sessionPatch = this.resolveSessionConfigPatch(params.configId, params.value);

    try {
      await this.gateway.request("sessions.patch", {
        key: session.sessionKey,
        ...sessionPatch.patch,
      });
      this.log(
        `setSessionConfigOption: ${session.sessionId} -> ${params.configId}=${params.value}`,
      );
      const sessionSnapshot = await this.getSessionSnapshot(
        session.sessionKey,
        sessionPatch.overrides,
      );
      await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
        includeControls: true,
      });
      return {
        configOptions: sessionSnapshot.configOptions,
      };
    } catch (error) {
      this.log(`setSessionConfigOption error: ${String(error)}`);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    if (session.abortController) {
      this.sessionStore.cancelActiveRun(params.sessionId);
    }

    const meta = parseSessionMeta(params._meta);
    // Pass MAX_PROMPT_BYTES so extractTextFromPrompt rejects oversized content
    // Block-by-block, before the full string is ever assembled in memory (CWE-400)
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    const prefixCwd = meta.prefixCwd ?? this.opts.prefixCwd ?? true;
    const displayCwd = shortenHomePath(session.cwd);
    const message = prefixCwd ? `[Working directory: ${displayCwd}]\n\n${userText}` : userText;
    const provenanceMode = this.opts.provenanceMode ?? "off";
    const systemInputProvenance =
      provenanceMode === "off" ? undefined : buildSystemInputProvenance(params.sessionId);
    const systemProvenanceReceipt =
      provenanceMode === "meta+receipt"
        ? buildSystemProvenanceReceipt({
            cwd: session.cwd,
            sessionId: params.sessionId,
            sessionKey: session.sessionKey,
          })
        : undefined;

    // Defense-in-depth: also check the final assembled message (includes cwd prefix)
    if (Buffer.byteLength(message, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }

    const abortController = new AbortController();
    const runId = randomUUID();
    this.sessionStore.setActiveRun(params.sessionId, runId, abortController);
    const requestParams = {
      attachments: attachments.length > 0 ? attachments : undefined,
      deliver: readBool(params._meta, ["deliver"]),
      idempotencyKey: runId,
      message,
      sessionKey: session.sessionKey,
      thinking: readString(params._meta, ["thinking", "thinkingLevel"]),
      timeoutMs: readNumber(params._meta, ["timeoutMs"]),
    };

    return new Promise<PromptResponse>((resolve, reject) => {
      this.pendingPrompts.set(params.sessionId, {
        disconnectContext: this.activeDisconnectContext ?? undefined,
        idempotencyKey: runId,
        reject,
        resolve,
        sessionId: params.sessionId,
        sessionKey: session.sessionKey,
      });
      if (this.activeDisconnectContext && !this.disconnectTimer) {
        this.armDisconnectTimer(this.activeDisconnectContext);
      }

      const sendWithProvenanceFallback = async () => {
        try {
          await this.gateway.request(
            "chat.send",
            {
              ...requestParams,
              systemInputProvenance,
              systemProvenanceReceipt,
            },
            { timeoutMs: null },
          );
          const pending = this.getPendingPrompt(params.sessionId, runId);
          if (pending) {
            pending.sendAccepted = true;
          }
        } catch (error) {
          if (
            (systemInputProvenance || systemProvenanceReceipt) &&
            isAdminScopeProvenanceRejection(error)
          ) {
            await this.gateway.request("chat.send", requestParams, { timeoutMs: null });
            const pending = this.getPendingPrompt(params.sessionId, runId);
            if (pending) {
              pending.sendAccepted = true;
            }
            return;
          }
          throw error;
        }
      };

      void sendWithProvenanceFallback().catch((error) => {
        if (isGatewayCloseError(error) && this.getPendingPrompt(params.sessionId, runId)) {
          return;
        }
        this.pendingPrompts.delete(params.sessionId);
        this.sessionStore.clearActiveRun(params.sessionId);
        if (this.pendingPrompts.size === 0) {
          this.clearDisconnectTimer();
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      return;
    }
    // Capture runId before cancelActiveRun clears session.activeRunId.
    const { activeRunId } = session;

    this.sessionStore.cancelActiveRun(params.sessionId);
    const pending = this.pendingPrompts.get(params.sessionId);
    const scopedRunId = activeRunId ?? pending?.idempotencyKey;
    if (!scopedRunId) {
      return;
    }

    try {
      await this.gateway.request("chat.abort", {
        runId: scopedRunId,
        sessionKey: session.sessionKey,
      });
    } catch (error) {
      this.log(`cancel error: ${String(error)}`);
    }

    if (pending) {
      this.pendingPrompts.delete(params.sessionId);
      if (this.pendingPrompts.size === 0) {
        this.clearDisconnectTimer();
      }
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  private async resolveSessionKeyFromMeta(params: {
    meta: ReturnType<typeof parseSessionMeta>;
    fallbackKey: string;
  }): Promise<string> {
    const sessionKey = await resolveSessionKey({
      fallbackKey: params.fallbackKey,
      gateway: this.gateway,
      meta: params.meta,
      opts: this.opts,
    });
    await resetSessionIfNeeded({
      gateway: this.gateway,
      meta: params.meta,
      opts: this.opts,
      sessionKey,
    });
    return sessionKey;
  }

  private async handleAgentEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    const stream = payload.stream as string | undefined;
    const runId = payload.runId as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const sessionKey = payload.sessionKey as string | undefined;
    if (!stream || !data || !sessionKey) {
      return;
    }

    if (stream !== "tool") {
      return;
    }
    const phase = data.phase as string | undefined;
    const name = data.name as string | undefined;
    const toolCallId = data.toolCallId as string | undefined;
    if (!toolCallId) {
      return;
    }

    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    if (phase === "start") {
      if (!pending.toolCalls) {
        pending.toolCalls = new Map();
      }
      if (pending.toolCalls.has(toolCallId)) {
        return;
      }
      const args = data.args as Record<string, unknown> | undefined;
      const title = formatToolTitle(name, args);
      const kind = inferToolKind(name);
      const locations = extractToolCallLocations(args);
      pending.toolCalls.set(toolCallId, {
        kind,
        locations,
        rawInput: args,
        title,
      });
      await this.connection.sessionUpdate({
        sessionId: pending.sessionId,
        update: {
          kind,
          locations,
          rawInput: args,
          sessionUpdate: "tool_call",
          status: "in_progress",
          title,
          toolCallId,
        },
      });
      return;
    }

    if (phase === "update") {
      const toolState = pending.toolCalls?.get(toolCallId);
      const { partialResult } = data;
      await this.connection.sessionUpdate({
        sessionId: pending.sessionId,
        update: {
          content: extractToolCallContent(partialResult),
          locations: extractToolCallLocations(toolState?.locations, partialResult),
          rawOutput: partialResult,
          sessionUpdate: "tool_call_update",
          status: "in_progress",
          toolCallId,
        },
      });
      return;
    }

    if (phase === "result") {
      const isError = Boolean(data.isError);
      const toolState = pending.toolCalls?.get(toolCallId);
      pending.toolCalls?.delete(toolCallId);
      await this.connection.sessionUpdate({
        sessionId: pending.sessionId,
        update: {
          content: extractToolCallContent(data.result),
          locations: extractToolCallLocations(toolState?.locations, data.result),
          rawOutput: data.result,
          sessionUpdate: "tool_call_update",
          status: isError ? "failed" : "completed",
          toolCallId,
        },
      });
    }
  }

  private async handleChatEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }

    const sessionKey = payload.sessionKey as string | undefined;
    const state = payload.state as string | undefined;
    const runId = payload.runId as string | undefined;
    const messageData = payload.message as Record<string, unknown> | undefined;
    if (!sessionKey || !state) {
      return;
    }

    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    const shouldHandleMessageSnapshot = messageData && (state === "delta" || state === "final");
    if (shouldHandleMessageSnapshot) {
      // Gateway chat events can carry the latest full assistant snapshot on both
      // Incremental updates and the terminal final event. Process the snapshot
      // First so ACP clients never drop the last visible assistant text.
      await this.handleDeltaEvent(pending.sessionId, messageData);
      if (state === "delta") {
        return;
      }
    }

    if (state === "final") {
      const rawStopReason = payload.stopReason as string | undefined;
      const stopReason: StopReason = rawStopReason === "max_tokens" ? "max_tokens" : "end_turn";
      await this.finishPrompt(pending.sessionId, pending, stopReason);
      return;
    }
    if (state === "aborted") {
      await this.finishPrompt(pending.sessionId, pending, "cancelled");
      return;
    }
    if (state === "error") {
      const errorKind = payload.errorKind as string | undefined;
      const stopReason: StopReason = errorKind === "refusal" ? "refusal" : "end_turn";
      void this.finishPrompt(pending.sessionId, pending, stopReason);
    }
  }

  private async handleDeltaEvent(
    sessionId: string,
    messageData: Record<string, unknown>,
  ): Promise<void> {
    const content = messageData.content as GatewayChatContentBlock[] | undefined;
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) {
      return;
    }

    const fullThought = content
      ?.filter((block) => block?.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("\n")
      .trimEnd();
    const sentThoughtSoFar = pending.sentThoughtLength ?? 0;
    if (fullThought && fullThought.length > sentThoughtSoFar) {
      const newThought = fullThought.slice(sentThoughtSoFar);
      pending.sentThoughtLength = fullThought.length;
      pending.sentThought = fullThought;
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          content: { text: newThought, type: "text" },
          sessionUpdate: "agent_thought_chunk",
        },
      });
    }

    const fullText = content
      ?.filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trimEnd();
    const sentSoFar = pending.sentTextLength ?? 0;
    if (!fullText || fullText.length <= sentSoFar) {
      return;
    }

    const newText = fullText.slice(sentSoFar);
    pending.sentTextLength = fullText.length;
    pending.sentText = fullText;
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        content: { text: newText, type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
  }

  private async finishPrompt(
    sessionId: string,
    pending: PendingPrompt,
    stopReason: StopReason,
  ): Promise<void> {
    this.pendingPrompts.delete(sessionId);
    this.sessionStore.clearActiveRun(sessionId);
    if (this.pendingPrompts.size === 0) {
      this.clearDisconnectTimer();
    }
    const sessionSnapshot = await this.getSessionSnapshot(pending.sessionKey);
    try {
      await this.sendSessionSnapshotUpdate(sessionId, sessionSnapshot, {
        includeControls: false,
      });
    } catch (error) {
      this.log(`session snapshot update failed for ${sessionId}: ${String(error)}`);
    }
    pending.resolve({ stopReason });
  }

  private findPendingBySessionKey(sessionKey: string, runId?: string): PendingPrompt | undefined {
    for (const pending of this.pendingPrompts.values()) {
      if (pending.sessionKey !== sessionKey) {
        continue;
      }
      if (runId && pending.idempotencyKey !== runId) {
        continue;
      }
      return pending;
    }
    return undefined;
  }

  private clearDisconnectTimer(): void {
    if (!this.disconnectTimer) {
      return;
    }
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private armDisconnectTimer(disconnectContext: DisconnectContext): void {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      void this.reconcilePendingPrompts(disconnectContext.generation, true);
    }, ACP_GATEWAY_DISCONNECT_GRACE_MS);
    this.disconnectTimer.unref?.();
  }

  private rejectPendingPrompt(pending: PendingPrompt, error: Error): void {
    const currentPending = this.getPendingPrompt(pending.sessionId, pending.idempotencyKey);
    if (currentPending !== pending) {
      return;
    }
    this.pendingPrompts.delete(pending.sessionId);
    this.sessionStore.clearActiveRun(pending.sessionId);
    if (this.pendingPrompts.size === 0) {
      this.clearDisconnectTimer();
    }
    pending.reject(error);
  }

  private clearPendingDisconnectState(
    pending: PendingPrompt,
    disconnectContext: DisconnectContext,
  ): void {
    if (pending.disconnectContext !== disconnectContext) {
      return;
    }
    pending.disconnectContext = undefined;
  }

  private shouldRejectPendingAtDisconnectDeadline(
    pending: PendingPrompt,
    disconnectContext: DisconnectContext,
  ): boolean {
    return (
      pending.disconnectContext === disconnectContext &&
      (!pending.sendAccepted ||
        this.activeDisconnectContext?.generation === disconnectContext.generation)
    );
  }

  private async reconcilePendingPrompts(
    observedDisconnectGeneration: number,
    deadlineExpired: boolean,
  ): Promise<void> {
    if (this.pendingPrompts.size === 0) {
      if (this.disconnectGeneration === observedDisconnectGeneration) {
        this.clearDisconnectTimer();
      }
      return;
    }

    const pendingEntries = [...this.pendingPrompts.entries()];
    let keepDisconnectTimer = false;
    for (const [sessionId, pending] of pendingEntries) {
      if (this.pendingPrompts.get(sessionId) !== pending) {
        continue;
      }
      if (pending.disconnectContext?.generation !== observedDisconnectGeneration) {
        continue;
      }
      const shouldKeepPending = await this.reconcilePendingPrompt(
        sessionId,
        pending,
        deadlineExpired,
      );
      if (shouldKeepPending) {
        keepDisconnectTimer = true;
      }
    }

    if (!keepDisconnectTimer && this.disconnectGeneration === observedDisconnectGeneration) {
      this.clearDisconnectTimer();
    }
  }

  private async reconcilePendingPrompt(
    sessionId: string,
    pending: PendingPrompt,
    deadlineExpired: boolean,
  ): Promise<boolean> {
    const { disconnectContext } = pending;
    if (!disconnectContext) {
      return false;
    }
    let result: AgentWaitResult | undefined;
    try {
      result = await this.gateway.request<AgentWaitResult>(
        "agent.wait",
        {
          runId: pending.idempotencyKey,
          timeoutMs: 0,
        },
        { timeoutMs: null },
      );
    } catch (error) {
      this.log(`agent.wait reconcile failed for ${pending.idempotencyKey}: ${String(error)}`);
      if (deadlineExpired) {
        if (this.shouldRejectPendingAtDisconnectDeadline(pending, disconnectContext)) {
          this.rejectPendingPrompt(
            pending,
            new Error(`Gateway disconnected: ${disconnectContext.reason}`),
          );
          return false;
        }
        this.clearPendingDisconnectState(pending, disconnectContext);
        return false;
      }
      return true;
    }

    const currentPending = this.getPendingPrompt(sessionId, pending.idempotencyKey);
    if (!currentPending) {
      return false;
    }
    if (result?.status === "ok") {
      await this.finishPrompt(sessionId, currentPending, "end_turn");
      return false;
    }
    if (result?.status === "error") {
      void this.finishPrompt(sessionId, currentPending, "end_turn");
      return false;
    }
    if (deadlineExpired) {
      if (this.shouldRejectPendingAtDisconnectDeadline(currentPending, disconnectContext)) {
        const currentDisconnectContext = currentPending.disconnectContext;
        if (!currentDisconnectContext) {
          return false;
        }
        this.rejectPendingPrompt(
          currentPending,
          new Error(`Gateway disconnected: ${currentDisconnectContext.reason}`),
        );
        return false;
      }
      this.clearPendingDisconnectState(currentPending, disconnectContext);
      return false;
    }
    return true;
  }

  private async sendAvailableCommands(sessionId: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        availableCommands: getAvailableCommands(),
        sessionUpdate: "available_commands_update",
      },
    });
  }

  private async getSessionSnapshot(
    sessionKey: string,
    overrides?: Partial<GatewaySessionPresentationRow>,
  ): Promise<SessionSnapshot> {
    try {
      const row = await this.getGatewaySessionRow(sessionKey);
      return {
        ...buildSessionPresentation({ overrides, row }),
        metadata: buildSessionMetadata({ row, sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    } catch (error) {
      this.log(`session presentation fallback for ${sessionKey}: ${String(error)}`);
      return {
        ...buildSessionPresentation({ overrides }),
        metadata: buildSessionMetadata({ sessionKey }),
      };
    }
  }

  private async getGatewaySessionRow(
    sessionKey: string,
  ): Promise<GatewaySessionPresentationRow | undefined> {
    const result = await this.gateway.request<SessionsListResult>("sessions.list", {
      includeDerivedTitles: true,
      limit: 200,
      search: sessionKey,
    });
    const session = result.sessions.find((entry) => entry.key === sessionKey);
    if (!session) {
      return undefined;
    }
    return {
      contextTokens: session.contextTokens,
      derivedTitle: session.derivedTitle,
      displayName: session.displayName,
      elevatedLevel: session.elevatedLevel,
      fastMode: session.fastMode,
      label: session.label,
      model: session.model,
      modelProvider: session.modelProvider,
      reasoningLevel: session.reasoningLevel,
      responseUsage: session.responseUsage,
      thinkingLevel: session.thinkingLevel,
      totalTokens: session.totalTokens,
      totalTokensFresh: session.totalTokensFresh,
      updatedAt: session.updatedAt,
      verboseLevel: session.verboseLevel,
    };
  }

  private resolveSessionConfigPatch(
    configId: string,
    value: string | boolean,
  ): {
    overrides: Partial<GatewaySessionPresentationRow>;
    patch: Record<string, string | boolean>;
  } {
    if (typeof value !== "string") {
      throw new Error(
        `ACP bridge does not support non-string session config option values for "${configId}".`,
      );
    }
    switch (configId) {
      case ACP_THOUGHT_LEVEL_CONFIG_ID: {
        return {
          overrides: { thinkingLevel: value },
          patch: { thinkingLevel: value },
        };
      }
      case ACP_FAST_MODE_CONFIG_ID: {
        return {
          overrides: { fastMode: value === "on" },
          patch: { fastMode: value === "on" },
        };
      }
      case ACP_VERBOSE_LEVEL_CONFIG_ID: {
        return {
          overrides: { verboseLevel: value },
          patch: { verboseLevel: value },
        };
      }
      case ACP_REASONING_LEVEL_CONFIG_ID: {
        return {
          overrides: { reasoningLevel: value },
          patch: { reasoningLevel: value },
        };
      }
      case ACP_RESPONSE_USAGE_CONFIG_ID: {
        return {
          overrides: { responseUsage: value as GatewaySessionPresentationRow["responseUsage"] },
          patch: { responseUsage: value },
        };
      }
      case ACP_ELEVATED_LEVEL_CONFIG_ID: {
        return {
          overrides: { elevatedLevel: value },
          patch: { elevatedLevel: value },
        };
      }
      default: {
        throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
      }
    }
  }

  private async getSessionTranscript(sessionKey: string): Promise<GatewayTranscriptMessage[]> {
    const result = await this.gateway.request<{ messages?: unknown[] }>("sessions.get", {
      key: sessionKey,
      limit: ACP_LOAD_SESSION_REPLAY_LIMIT,
    });
    if (!Array.isArray(result.messages)) {
      return [];
    }
    return result.messages as GatewayTranscriptMessage[];
  }

  private async replaySessionTranscript(
    sessionId: string,
    transcript: readonly GatewayTranscriptMessage[],
  ): Promise<void> {
    for (const message of transcript) {
      const replayChunks = extractReplayChunks(message);
      for (const chunk of replayChunks) {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            content: { text: chunk.text, type: "text" },
            sessionUpdate: chunk.sessionUpdate,
          },
        });
      }
    }
  }

  private async sendSessionSnapshotUpdate(
    sessionId: string,
    sessionSnapshot: SessionSnapshot,
    options: { includeControls: boolean },
  ): Promise<void> {
    if (options.includeControls) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          currentModeId: sessionSnapshot.modes.currentModeId,
          sessionUpdate: "current_mode_update",
        },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          configOptions: sessionSnapshot.configOptions,
          sessionUpdate: "config_option_update",
        },
      });
    }
    if (sessionSnapshot.metadata) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          ...sessionSnapshot.metadata,
        },
      });
    }
    if (sessionSnapshot.usage) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          _meta: {
            approximate: true,
            source: "gateway-session-store",
          },
          sessionUpdate: "usage_update",
          size: sessionSnapshot.usage.size,
          used: sessionSnapshot.usage.used,
        },
      });
    }
  }

  private assertSupportedSessionSetup(mcpServers: readonly unknown[]): void {
    if (mcpServers.length === 0) {
      return;
    }
    throw new Error(
      "ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead.",
    );
  }

  private enforceSessionCreateRateLimit(method: "newSession" | "loadSession"): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1000)}s.`,
    );
  }
}
