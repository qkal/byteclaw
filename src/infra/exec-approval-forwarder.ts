import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin, resolveChannelApprovalAdapter } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type {
  ExecApprovalForwardTarget,
  ExecApprovalForwardingConfig,
} from "../config/types.approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildApprovalPendingReplyPayload,
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
} from "../plugin-sdk/approval-renderers.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  type DeliverableMessageChannel,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { formatExecApprovalExpiresIn } from "./exec-approval-reply.js";
import {
  type ExecApprovalRequest,
  type ExecApprovalResolved,
  resolveExecApprovalRequestAllowedDecisions,
} from "./exec-approvals.js";
import {
  type PluginApprovalRequest,
  type PluginApprovalResolved,
  approvalDecisionLabel,
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalRequestMessage,
} from "./plugin-approvals.js";

const log = createSubsystemLogger("gateway/exec-approvals");
export type { ExecApprovalRequest, ExecApprovalResolved };

type DeliverOutboundPayloads = typeof import("./outbound/deliver.js").deliverOutboundPayloads;
type MaybePromise<T> = T | Promise<T>;
type ResolveSessionTargetFn = (params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}) => MaybePromise<ExecApprovalForwardTarget | null>;

type ApprovalKind = "exec" | "plugin";
type ForwardTarget = ExecApprovalForwardTarget & { source: "session" | "target" };

interface ApprovalRouteRequest {
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}

interface PendingApproval<TRouteRequest extends ApprovalRouteRequest> {
  routeRequest: TRouteRequest;
  targets: ForwardTarget[];
  timeoutId: NodeJS.Timeout | null;
}

interface ApprovalRenderContext<TRouteRequest extends ApprovalRouteRequest> {
  cfg: OpenClawConfig;
  target: ForwardTarget;
  routeRequest: TRouteRequest;
}

type ApprovalPendingRenderContext<
  TRequest,
  TRouteRequest extends ApprovalRouteRequest,
> = ApprovalRenderContext<TRouteRequest> & {
  request: TRequest;
  nowMs: number;
};

type ApprovalResolvedRenderContext<
  TResolved,
  TRouteRequest extends ApprovalRouteRequest,
> = ApprovalRenderContext<TRouteRequest> & {
  resolved: TResolved;
};

interface ApprovalStrategy<
  TRequest,
  TResolved,
  TRouteRequest extends ApprovalRouteRequest = ApprovalRouteRequest,
> {
  kind: ApprovalKind;
  config: (cfg: OpenClawConfig) => ExecApprovalForwardingConfig | undefined;
  getRequestId: (request: TRequest) => string;
  getResolvedId: (resolved: TResolved) => string;
  getExpiresAtMs: (request: TRequest) => number;
  getRouteRequestFromRequest: (request: TRequest) => TRouteRequest;
  getRouteRequestFromResolved: (resolved: TResolved) => TRouteRequest | null;
  buildExpiredText: (request: TRequest) => string;
  buildPendingPayload: (
    params: ApprovalPendingRenderContext<TRequest, TRouteRequest>,
  ) => ReplyPayload;
  buildResolvedPayload: (
    params: ApprovalResolvedRenderContext<TResolved, TRouteRequest>,
  ) => ReplyPayload;
}

interface ApprovalRouteRequestFields {
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}

export interface ExecApprovalForwarder {
  handleRequested: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved: (resolved: ExecApprovalResolved) => Promise<void>;
  handlePluginApprovalRequested?: (request: PluginApprovalRequest) => Promise<boolean>;
  handlePluginApprovalResolved?: (resolved: PluginApprovalResolved) => Promise<void>;
  stop: () => void;
}

export interface ExecApprovalForwarderDeps {
  getConfig?: () => OpenClawConfig;
  deliver?: DeliverOutboundPayloads;
  nowMs?: () => number;
  resolveSessionTarget?: ResolveSessionTargetFn;
}

const DEFAULT_MODE = "session" as const;
const SYNTHETIC_APPROVAL_REQUEST_ID = "__approval-routing__";
let execApprovalForwarderRuntimePromise: Promise<
  typeof import("./exec-approval-forwarder.runtime.js")
> | null = null;

function loadExecApprovalForwarderRuntime() {
  execApprovalForwarderRuntimePromise ??= import("./exec-approval-forwarder.runtime.js");
  return execApprovalForwarderRuntimePromise;
}

function normalizeMode(mode?: ExecApprovalForwardingConfig["mode"]) {
  return mode ?? DEFAULT_MODE;
}

function shouldForwardRoute(params: {
  config?: {
    enabled?: boolean;
    agentFilter?: string[];
    sessionFilter?: string[];
  };
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const { config } = params;
  if (!config?.enabled) {
    return false;
  }
  return matchesApprovalRequestFilters({
    agentFilter: config.agentFilter,
    fallbackAgentIdFromSessionKey: true,
    request: params.routeRequest,
    sessionFilter: config.sessionFilter,
  });
}

function buildTargetKey(target: ExecApprovalForwardTarget): string {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  const accountId = target.accountId ?? "";
  const threadId = target.threadId ?? "";
  return [channel, target.to, accountId, threadId].join(":");
}

function buildSyntheticApprovalRequest(routeRequest: ApprovalRouteRequest): ExecApprovalRequest {
  return {
    createdAtMs: 0,
    expiresAtMs: 0,
    id: SYNTHETIC_APPROVAL_REQUEST_ID,
    request: {
      agentId: routeRequest.agentId ?? null,
      command: "",
      sessionKey: routeRequest.sessionKey ?? null,
      turnSourceAccountId: routeRequest.turnSourceAccountId ?? null,
      turnSourceChannel: routeRequest.turnSourceChannel ?? null,
      turnSourceThreadId: routeRequest.turnSourceThreadId ?? null,
      turnSourceTo: routeRequest.turnSourceTo ?? null,
    },
  };
}

function shouldSkipForwardingFallback(params: {
  approvalKind: "exec" | "plugin";
  target: ExecApprovalForwardTarget;
  cfg: OpenClawConfig;
  routeRequest: ApprovalRouteRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (!channel) {
    return false;
  }
  const adapter = resolveChannelApprovalAdapter(getChannelPlugin(channel));
  return (
    adapter?.delivery?.shouldSuppressForwardingFallback?.({
      approvalKind: params.approvalKind,
      cfg: params.cfg,
      request: buildSyntheticApprovalRequest(params.routeRequest),
      target: params.target,
    }) ?? false
  );
}

function formatApprovalCommand(command: string): { inline: boolean; text: string } {
  if (!command.includes("\n") && !command.includes("`")) {
    return { inline: true, text: `\`${command}\`` };
  }

  let fence = "```";
  while (command.includes(fence)) {
    fence += "`";
  }
  return { inline: false, text: `${fence}\n${command}\n${fence}` };
}

function buildRequestMessage(request: ExecApprovalRequest, nowMs: number) {
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
  const decisionText = allowedDecisions.join("|");
  const lines: string[] = ["🔒 Exec approval required", `ID: ${request.id}`];
  const command = formatApprovalCommand(
    resolveExecApprovalCommandDisplay(request.request).commandText,
  );
  if (command.inline) {
    lines.push(`Command: ${command.text}`);
  } else {
    lines.push("Command:");
    lines.push(command.text);
  }
  if (request.request.cwd) {
    lines.push(`CWD: ${request.request.cwd}`);
  }
  if (request.request.nodeId) {
    lines.push(`Node: ${request.request.nodeId}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`Env overrides: ${request.request.envKeys.join(", ")}`);
  }
  if (request.request.host) {
    lines.push(`Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  if (request.request.security) {
    lines.push(`Security: ${request.request.security}`);
  }
  if (request.request.ask) {
    lines.push(`Ask: ${request.request.ask}`);
  }
  lines.push(`Expires in: ${formatExecApprovalExpiresIn(request.expiresAtMs, nowMs)}`);
  lines.push("Mode: foreground (interactive approvals available in this chat).");
  lines.push(
    allowedDecisions.includes("allow-always")
      ? "Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off)."
      : "Background mode note: non-interactive runs cannot wait for chat approvals; the effective policy still requires per-run approval unless ask=off.",
  );
  lines.push(`Reply with: /approve <id> ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push(
      "Allow Always is unavailable because the effective policy requires approval every time.",
    );
  }
  return lines.join("\n");
}

const decisionLabel = approvalDecisionLabel;

function buildResolvedMessage(resolved: ExecApprovalResolved) {
  const base = `✅ Exec approval ${decisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

function buildExpiredMessage(request: ExecApprovalRequest) {
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

function normalizeTurnSourceChannel(value?: string | null): DeliverableMessageChannel | undefined {
  const normalized = value ? normalizeMessageChannel(value) : undefined;
  return normalized && isDeliverableMessageChannel(normalized) ? normalized : undefined;
}

function extractApprovalRouteRequest(
  request: ApprovalRouteRequestFields | null | undefined,
): ApprovalRouteRequest | null {
  if (!request) {
    return null;
  }
  return {
    agentId: request.agentId ?? null,
    sessionKey: request.sessionKey ?? null,
    turnSourceAccountId: request.turnSourceAccountId ?? null,
    turnSourceChannel: request.turnSourceChannel ?? null,
    turnSourceThreadId: request.turnSourceThreadId ?? null,
    turnSourceTo: request.turnSourceTo ?? null,
  };
}

function defaultResolveSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): Promise<ExecApprovalForwardTarget | null> {
  return loadExecApprovalForwarderRuntime().then(({ resolveExecApprovalSessionTarget }) => {
    const resolvedTarget = resolveExecApprovalSessionTarget({
      cfg: params.cfg,
      request: params.request,
      turnSourceAccountId: normalizeOptionalString(params.request.request.turnSourceAccountId),
      turnSourceChannel: normalizeTurnSourceChannel(params.request.request.turnSourceChannel),
      turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
      turnSourceTo: normalizeOptionalString(params.request.request.turnSourceTo),
    });
    if (!resolvedTarget?.channel || !resolvedTarget.to) {
      return null;
    }
    const { channel } = resolvedTarget;
    if (!isDeliverableMessageChannel(channel)) {
      return null;
    }
    return {
      accountId: resolvedTarget.accountId,
      channel,
      threadId: resolvedTarget.threadId,
      to: resolvedTarget.to,
    };
  });
}

async function deliverToTargets(params: {
  cfg: OpenClawConfig;
  targets: ForwardTarget[];
  buildPayload: (target: ForwardTarget) => ReplyPayload;
  deliver: DeliverOutboundPayloads;
  beforeDeliver?: (target: ForwardTarget, payload: ReplyPayload) => Promise<void> | void;
  shouldSend?: () => boolean;
}) {
  const deliveries = params.targets.map(async (target) => {
    if (params.shouldSend && !params.shouldSend()) {
      return;
    }
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (!isDeliverableMessageChannel(channel)) {
      return;
    }
    try {
      const payload = params.buildPayload(target);
      await params.beforeDeliver?.(target, payload);
      await params.deliver({
        accountId: target.accountId,
        cfg: params.cfg,
        channel,
        payloads: [payload],
        threadId: target.threadId,
        to: target.to,
      });
    } catch (error) {
      log.error(`exec approvals: failed to deliver to ${channel}:${target.to}: ${String(error)}`);
    }
  });
  await Promise.allSettled(deliveries);
}

function buildApprovalRenderPayload<TParams>(params: {
  target: ForwardTarget;
  renderParams: TParams;
  resolveRenderer: (
    adapter: ReturnType<typeof resolveChannelApprovalAdapter> | undefined,
  ) => ((params: TParams) => ReplyPayload | null) | undefined;
  buildFallback: () => ReplyPayload;
}): ReplyPayload {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  const adapterPayload = channel
    ? params.resolveRenderer(resolveChannelApprovalAdapter(getChannelPlugin(channel)))?.(
        params.renderParams,
      )
    : null;
  return adapterPayload ?? params.buildFallback();
}

function buildExecPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: ForwardTarget;
  nowMs: number;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    buildFallback: () =>
      buildApprovalPendingReplyPayload({
        agentId: params.request.request.agentId ?? null,
        allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
        approvalId: params.request.id,
        approvalSlug: params.request.id.slice(0, 8),
        sessionKey: params.request.request.sessionKey ?? null,
        text: buildRequestMessage(params.request, params.nowMs),
      }),
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.exec?.buildPendingPayload,
    target: params.target,
  });
}

function buildExecResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: ExecApprovalResolved;
  target: ForwardTarget;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    buildFallback: () =>
      buildApprovalResolvedReplyPayload({
        approvalId: params.resolved.id,
        approvalSlug: params.resolved.id.slice(0, 8),
        text: buildResolvedMessage(params.resolved),
      }),
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.exec?.buildResolvedPayload,
    target: params.target,
  });
}

function buildPluginPendingPayload(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
  target: ForwardTarget;
  nowMs: number;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    buildFallback: () =>
      buildPluginApprovalPendingReplyPayload({
        nowMs: params.nowMs,
        request: params.request,
        text: buildPluginApprovalRequestMessage(params.request, params.nowMs),
      }),
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.plugin?.buildPendingPayload,
    target: params.target,
  });
}

function buildPluginResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: PluginApprovalResolved;
  target: ForwardTarget;
}): ReplyPayload {
  return buildApprovalRenderPayload({
    buildFallback: () =>
      buildPluginApprovalResolvedReplyPayload({
        resolved: params.resolved,
      }),
    renderParams: params,
    resolveRenderer: (adapter) => adapter?.render?.plugin?.buildResolvedPayload,
    target: params.target,
  });
}

async function resolveForwardTargets(params: {
  cfg: OpenClawConfig;
  config?: ExecApprovalForwardingConfig;
  routeRequest: ApprovalRouteRequest;
  resolveSessionTarget: ResolveSessionTargetFn;
}): Promise<ForwardTarget[]> {
  const mode = normalizeMode(params.config?.mode);
  const targets: ForwardTarget[] = [];
  const seen = new Set<string>();

  if (mode === "session" || mode === "both") {
    const sessionTarget = await params.resolveSessionTarget({
      cfg: params.cfg,
      request: buildSyntheticApprovalRequest(params.routeRequest),
    });
    if (sessionTarget) {
      const key = buildTargetKey(sessionTarget);
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ ...sessionTarget, source: "session" });
      }
    }
  }

  if (mode === "targets" || mode === "both") {
    const explicitTargets = params.config?.targets ?? [];
    for (const target of explicitTargets) {
      const key = buildTargetKey(target);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({ ...target, source: "target" });
    }
  }

  return targets;
}

function createApprovalHandlers<
  TRequest,
  TResolved,
  TRouteRequest extends ApprovalRouteRequest = ApprovalRouteRequest,
>(params: {
  strategy: ApprovalStrategy<TRequest, TResolved, TRouteRequest>;
  getConfig: () => OpenClawConfig;
  deliver: DeliverOutboundPayloads;
  nowMs: () => number;
  resolveSessionTarget: ResolveSessionTargetFn;
}) {
  const pending = new Map<string, PendingApproval<TRouteRequest>>();

  const handleRequested = async (request: TRequest): Promise<boolean> => {
    const cfg = params.getConfig();
    const config = params.strategy.config(cfg);
    const requestId = params.strategy.getRequestId(request);
    const routeRequest = params.strategy.getRouteRequestFromRequest(request);
    const filteredTargets = [
      ...(shouldForwardRoute({ config, routeRequest })
        ? await resolveForwardTargets({
            cfg,
            config,
            resolveSessionTarget: params.resolveSessionTarget,
            routeRequest,
          })
        : []),
    ].filter(
      (target) =>
        !shouldSkipForwardingFallback({
          approvalKind: params.strategy.kind,
          cfg,
          routeRequest,
          target,
        }),
    );
    if (filteredTargets.length === 0) {
      return false;
    }

    const expiresInMs = Math.max(0, params.strategy.getExpiresAtMs(request) - params.nowMs());
    const timeoutId = setTimeout(() => {
      void (async () => {
        const entry = pending.get(requestId);
        if (!entry) {
          return;
        }
        pending.delete(requestId);
        await deliverToTargets({
          buildPayload: () => ({ text: params.strategy.buildExpiredText(request) }),
          cfg,
          deliver: params.deliver,
          targets: entry.targets,
        });
      })();
    }, expiresInMs);
    timeoutId.unref?.();

    const pendingEntry: PendingApproval<TRouteRequest> = {
      routeRequest,
      targets: filteredTargets,
      timeoutId,
    };
    pending.set(requestId, pendingEntry);

    if (pending.get(requestId) !== pendingEntry) {
      return false;
    }

    void deliverToTargets({
      beforeDeliver: async (target, payload) => {
        const channel = normalizeMessageChannel(target.channel) ?? target.channel;
        if (!channel) {
          return;
        }
        await getChannelPlugin(channel)?.outbound?.beforeDeliverPayload?.({
          cfg,
          hint: {
            approvalKind: params.strategy.kind,
            kind: "approval-pending",
          },
          payload,
          target,
        });
      },
      buildPayload: (target) =>
        params.strategy.buildPendingPayload({
          cfg,
          nowMs: params.nowMs(),
          request,
          routeRequest,
          target,
        }),
      cfg,
      deliver: params.deliver,
      shouldSend: () => pending.get(requestId) === pendingEntry,
      targets: filteredTargets,
    }).catch((error) => {
      log.error(
        `${params.strategy.kind} approvals: failed to deliver request ${requestId}: ${String(error)}`,
      );
    });
    return true;
  };

  const handleResolved = async (resolved: TResolved) => {
    const resolvedId = params.strategy.getResolvedId(resolved);
    const entry = pending.get(resolvedId);
    if (entry?.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    if (entry) {
      pending.delete(resolvedId);
    }

    const cfg = params.getConfig();
    let targets = entry?.targets;
    if (!targets) {
      const routeRequest = params.strategy.getRouteRequestFromResolved(resolved);
      if (routeRequest) {
        const config = params.strategy.config(cfg);
        targets = [
          ...(shouldForwardRoute({ config, routeRequest })
            ? await resolveForwardTargets({
                cfg,
                config,
                resolveSessionTarget: params.resolveSessionTarget,
                routeRequest,
              })
            : []),
        ].filter(
          (target) =>
            !shouldSkipForwardingFallback({
              approvalKind: params.strategy.kind,
              cfg,
              routeRequest,
              target,
            }),
        );
      }
    }
    if (!targets?.length) {
      return;
    }

    await deliverToTargets({
      buildPayload: (target) =>
        params.strategy.buildResolvedPayload({
          cfg,
          resolved,
          routeRequest:
            entry?.routeRequest ??
            params.strategy.getRouteRequestFromResolved(resolved) ??
            ({} as TRouteRequest),
          target,
        }),
      cfg,
      deliver: params.deliver,
      targets,
    });
  };

  const stop = () => {
    for (const entry of pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
    }
    pending.clear();
  };

  return { handleRequested, handleResolved, stop };
}

function createApprovalStrategy<
  TRequest extends { id: string; request: ApprovalRouteRequestFields; expiresAtMs: number },
  TResolved extends { id: string; request?: ApprovalRouteRequestFields | null },
>(params: {
  kind: ApprovalKind;
  config: (cfg: OpenClawConfig) => ExecApprovalForwardingConfig | undefined;
  buildExpiredText: (request: TRequest) => string;
  buildPendingPayload: (
    params: ApprovalPendingRenderContext<TRequest, ApprovalRouteRequest>,
  ) => ReplyPayload;
  buildResolvedPayload: (
    params: ApprovalResolvedRenderContext<TResolved, ApprovalRouteRequest>,
  ) => ReplyPayload;
}): ApprovalStrategy<TRequest, TResolved> {
  return {
    buildExpiredText: params.buildExpiredText,
    buildPendingPayload: params.buildPendingPayload,
    buildResolvedPayload: params.buildResolvedPayload,
    config: params.config,
    getExpiresAtMs: (request) => request.expiresAtMs,
    getRequestId: (request) => request.id,
    getResolvedId: (resolved) => resolved.id,
    getRouteRequestFromRequest: (request) => extractApprovalRouteRequest(request.request) ?? {},
    getRouteRequestFromResolved: (resolved) => extractApprovalRouteRequest(resolved.request),
    kind: params.kind,
  };
}

const execApprovalStrategy = createApprovalStrategy<ExecApprovalRequest, ExecApprovalResolved>({
  buildExpiredText: buildExpiredMessage,
  buildPendingPayload: ({ cfg, request, target, nowMs }) =>
    buildExecPendingPayload({
      cfg,
      nowMs,
      request,
      target,
    }),
  buildResolvedPayload: ({ cfg, resolved, target }) =>
    buildExecResolvedPayload({
      cfg,
      resolved,
      target,
    }),
  config: (cfg) => cfg.approvals?.exec,
  kind: "exec",
});

const pluginApprovalStrategy = createApprovalStrategy<
  PluginApprovalRequest,
  PluginApprovalResolved
>({
  buildExpiredText: buildPluginApprovalExpiredMessage,
  buildPendingPayload: ({ cfg, request, target, nowMs }) =>
    buildPluginPendingPayload({
      cfg,
      nowMs,
      request,
      target,
    }),
  buildResolvedPayload: ({ cfg, resolved, target }) =>
    buildPluginResolvedPayload({
      cfg,
      resolved,
      target,
    }),
  config: (cfg) => cfg.approvals?.plugin,
  kind: "plugin",
});

export function createExecApprovalForwarder(
  deps: ExecApprovalForwarderDeps = {},
): ExecApprovalForwarder {
  const getConfig = deps.getConfig ?? loadConfig;
  const deliver =
    deps.deliver ??
    (async (params) => {
      const { deliverOutboundPayloads } = await loadExecApprovalForwarderRuntime();
      return deliverOutboundPayloads(params);
    });
  const nowMs = deps.nowMs ?? Date.now;
  const resolveSessionTarget = deps.resolveSessionTarget ?? defaultResolveSessionTarget;

  const execHandlers = createApprovalHandlers({
    deliver,
    getConfig,
    nowMs,
    resolveSessionTarget,
    strategy: execApprovalStrategy,
  });
  const pluginHandlers = createApprovalHandlers({
    deliver,
    getConfig,
    nowMs,
    resolveSessionTarget,
    strategy: pluginApprovalStrategy,
  });

  return {
    handlePluginApprovalRequested: pluginHandlers.handleRequested,
    handlePluginApprovalResolved: pluginHandlers.handleResolved,
    handleRequested: execHandlers.handleRequested,
    handleResolved: execHandlers.handleResolved,
    stop: () => {
      execHandlers.stop();
      pluginHandlers.stop();
    },
  };
}

export function shouldForwardExecApproval(params: {
  config?: ExecApprovalForwardingConfig;
  request: ExecApprovalRequest;
}): boolean {
  return shouldForwardRoute({
    config: params.config,
    routeRequest: execApprovalStrategy.getRouteRequestFromRequest(params.request),
  });
}
