import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { resolveGatewayInteractiveSurfaceAuth } from "../gateway/auth-surface-resolution.js";
import {
  buildGatewayConnectionDetails,
  ensureExplicitGatewayAuth,
  resolveExplicitGatewayAuth,
} from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { isLoopbackHost } from "../gateway/net.js";
import { GATEWAY_CLIENT_CAPS } from "../gateway/protocol/client-info.js";
import {
  type HelloOk,
  PROTOCOL_VERSION,
  type SessionsListParams,
  type SessionsPatchParams,
  type SessionsPatchResult,
} from "../gateway/protocol/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import type { ResponseUsageMode, SessionInfo, SessionScope } from "./tui-types.js";

export interface GatewayConnectionOptions {
  url?: string;
  token?: string;
  password?: string;
}

export interface ChatSendOptions {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
  runId?: string;
}

export interface GatewayEvent {
  event: string;
  payload?: unknown;
  seq?: number;
}

interface ResolvedGatewayConnection {
  url: string;
  token?: string;
  password?: string;
  allowInsecureLocalOperatorUi?: boolean;
}

function throwGatewayAuthResolutionError(reason: string): never {
  throw new Error(
    [
      reason,
      "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
      "or resolve the configured secret provider for this credential.",
    ].join("\n"),
  );
}

export interface GatewaySessionList {
  ts: number;
  path: string;
  count: number;
  defaults?: {
    model?: string | null;
    modelProvider?: string | null;
    contextTokens?: number | null;
  };
  sessions: (Pick<
      SessionInfo,
      | "thinkingLevel"
      | "fastMode"
      | "verboseLevel"
      | "reasoningLevel"
      | "model"
      | "contextTokens"
      | "inputTokens"
      | "outputTokens"
      | "totalTokens"
      | "modelProvider"
      | "displayName"
    > & {
      key: string;
      sessionId?: string;
      updatedAt?: number | null;
      fastMode?: boolean;
      sendPolicy?: string;
      responseUsage?: ResponseUsageMode;
      label?: string;
      provider?: string;
      groupChannel?: string;
      space?: string;
      subject?: string;
      chatType?: string;
      lastProvider?: string;
      lastTo?: string;
      lastAccountId?: string;
      derivedTitle?: string;
      lastMessagePreview?: string;
    })[];
}

export interface GatewayAgentsList {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: {
    id: string;
    name?: string;
  }[];
}

export interface GatewayModelChoice {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export class GatewayChatClient {
  private client: GatewayClient;
  private readyPromise: Promise<void>;
  private resolveReady?: () => void;
  readonly connection: { url: string; token?: string; password?: string };
  hello?: HelloOk;

  onEvent?: (evt: GatewayEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  constructor(connection: ResolvedGatewayConnection) {
    this.connection = connection;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.client = new GatewayClient({
      caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
      clientDisplayName: "openclaw-tui",
      clientName: GATEWAY_CLIENT_NAMES.TUI,
      clientVersion: VERSION,
      deviceIdentity: connection.allowInsecureLocalOperatorUi ? null : undefined,
      instanceId: randomUUID(),
      maxProtocol: PROTOCOL_VERSION,
      minProtocol: PROTOCOL_VERSION,
      mode: GATEWAY_CLIENT_MODES.UI,
      onClose: (_code, reason) => {
        // Reset so waitForReady() blocks again until the next successful reconnect.
        this.readyPromise = new Promise((resolve) => {
          this.resolveReady = resolve;
        });
        this.onDisconnected?.(reason);
      },
      onEvent: (evt) => {
        this.onEvent?.({
          event: evt.event,
          payload: evt.payload,
          seq: evt.seq,
        });
      },
      onGap: (info) => {
        this.onGap?.(info);
      },
      onHelloOk: (hello) => {
        this.hello = hello;
        this.resolveReady?.();
        this.onConnected?.();
      },
      password: connection.password,
      platform: process.platform,
      token: connection.token,
      url: connection.url,
    });
  }

  static async connect(opts: GatewayConnectionOptions): Promise<GatewayChatClient> {
    const connection = await resolveGatewayConnection(opts);
    return new GatewayChatClient(connection);
  }

  start() {
    this.client.start();
  }

  stop() {
    this.client.stop();
  }

  async waitForReady() {
    await this.readyPromise;
  }

  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = opts.runId ?? randomUUID();
    await this.client.request("chat.send", {
      deliver: opts.deliver,
      idempotencyKey: runId,
      message: opts.message,
      sessionKey: opts.sessionKey,
      thinking: opts.thinking,
      timeoutMs: opts.timeoutMs,
    });
    return { runId };
  }

  async abortChat(opts: { sessionKey: string; runId: string }) {
    return await this.client.request<{ ok: boolean; aborted: boolean }>("chat.abort", {
      runId: opts.runId,
      sessionKey: opts.sessionKey,
    });
  }

  async loadHistory(opts: { sessionKey: string; limit?: number }) {
    return await this.client.request("chat.history", {
      limit: opts.limit,
      sessionKey: opts.sessionKey,
    });
  }

  async listSessions(opts?: SessionsListParams) {
    return await this.client.request<GatewaySessionList>("sessions.list", {
      activeMinutes: opts?.activeMinutes,
      agentId: opts?.agentId,
      includeDerivedTitles: opts?.includeDerivedTitles,
      includeGlobal: opts?.includeGlobal,
      includeLastMessage: opts?.includeLastMessage,
      includeUnknown: opts?.includeUnknown,
      limit: opts?.limit,
    });
  }

  async listAgents() {
    return await this.client.request<GatewayAgentsList>("agents.list", {});
  }

  async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
    return await this.client.request<SessionsPatchResult>("sessions.patch", opts);
  }

  async resetSession(key: string, reason?: "new" | "reset") {
    return await this.client.request("sessions.reset", {
      key,
      ...(reason ? { reason } : {}),
    });
  }

  async getGatewayStatus() {
    return await this.client.request("status");
  }

  async listModels(): Promise<GatewayModelChoice[]> {
    const res = await this.client.request<{ models?: GatewayModelChoice[] }>("models.list");
    return Array.isArray(res?.models) ? res.models : [];
  }
}

export async function resolveGatewayConnection(
  opts: GatewayConnectionOptions,
): Promise<ResolvedGatewayConnection> {
  const config = loadConfig();
  const {env} = process;
  const gatewayAuthMode = config.gateway?.auth?.mode;
  const isRemoteMode = config.gateway?.mode === "remote";

  const urlOverride =
    typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined;
  const explicitAuth = resolveExplicitGatewayAuth({ password: opts.password, token: opts.token });
  ensureExplicitGatewayAuth({
    errorHint: "Fix: pass --token or --password when using --url.",
    explicitAuth,
    urlOverride,
    urlOverrideSource: "cli",
  });
  const {url} = buildGatewayConnectionDetails({
    config,
    ...(urlOverride ? { url: urlOverride } : {}),
  });
  const allowInsecureLocalOperatorUi = (() => {
    if (config.gateway?.controlUi?.allowInsecureAuth !== true) {
      return false;
    }
    try {
      return isLoopbackHost(new URL(url).hostname);
    } catch {
      return false;
    }
  })();

  if (urlOverride) {
    return {
      allowInsecureLocalOperatorUi,
      password: explicitAuth.password,
      token: explicitAuth.token,
      url,
    };
  }

  if (isRemoteMode) {
    const resolved = await resolveGatewayInteractiveSurfaceAuth({
      config,
      env,
      explicitAuth,
      surface: "remote",
    });
    if (resolved.failureReason) {
      throwGatewayAuthResolutionError(resolved.failureReason);
    }
    return {
      allowInsecureLocalOperatorUi: false,
      password: resolved.password,
      token: resolved.token,
      url,
    };
  }

  if (gatewayAuthMode === "none" || gatewayAuthMode === "trusted-proxy") {
    const resolved = await resolveGatewayInteractiveSurfaceAuth({
      config,
      env,
      explicitAuth,
      surface: "local",
    });
    return {
      allowInsecureLocalOperatorUi,
      password: resolved.password,
      token: resolved.token,
      url,
    };
  }

  try {
    assertExplicitGatewayAuthModeWhenBothConfigured(config);
  } catch (error) {
    throwGatewayAuthResolutionError(formatErrorMessage(error));
  }

  const resolved = await resolveGatewayInteractiveSurfaceAuth({
    config,
    env,
    explicitAuth,
    surface: "local",
  });
  if (resolved.failureReason) {
    throwGatewayAuthResolutionError(resolved.failureReason);
  }
  return {
    allowInsecureLocalOperatorUi,
    password: resolved.password,
    token: resolved.token,
    url,
  };
}
