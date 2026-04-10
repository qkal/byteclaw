import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  requestNodePairing,
  verifyNodeToken,
} from "../../infra/node-pairing.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  CANVAS_CAPABILITY_TTL_MS,
  buildCanvasScopedHostUrl,
  mintCanvasCapabilityToken,
} from "../canvas-capability.js";
import { createKnownNodeCatalog, getKnownNode, listKnownNodes } from "../node-catalog.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../node-invoke-sanitize.js";
import {
  type ConnectParams,
  ErrorCodes,
  errorShape,
  validateNodeDescribeParams,
  validateNodeEventParams,
  validateNodeInvokeParams,
  validateNodeListParams,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRequestParams,
  validateNodePairVerifyParams,
  validateNodePendingAckParams,
  validateNodeRenameParams,
} from "../protocol/index.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import {
  respondInvalidParams,
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

export const NODE_WAKE_RECONNECT_WAIT_MS = 3000;
export const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
export const NODE_WAKE_RECONNECT_POLL_MS = 150;
const NODE_WAKE_THROTTLE_MS = 15_000;
const NODE_WAKE_NUDGE_THROTTLE_MS = 10 * 60_000;
const NODE_PENDING_ACTION_TTL_MS = 10 * 60_000;
const NODE_PENDING_ACTION_MAX_PER_NODE = 64;

interface NodeWakeState {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
}

const nodeWakeById = new Map<string, NodeWakeState>();
const nodeWakeNudgeById = new Map<string, number>();

interface NodeWakeAttempt {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
}

interface NodeWakeNudgeAttempt {
  sent: boolean;
  throttled: boolean;
  reason: "throttled" | "no-registration" | "no-auth" | "send-error" | "apns-not-ok" | "sent";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
}

interface PendingNodeAction {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
  enqueuedAtMs: number;
}

const pendingNodeActionsById = new Map<string, PendingNodeAction[]>();

function normalizeBrowserProxyPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withLeadingSlash.length <= 1) {
    return withLeadingSlash;
  }
  return withLeadingSlash.replace(/\/+$/, "");
}

function isPersistentBrowserProxyMutation(method: string, path: string): boolean {
  const normalizedPath = normalizeBrowserProxyPath(path);
  if (
    method === "POST" &&
    (normalizedPath === "/profiles/create" || normalizedPath === "/reset-profile")
  ) {
    return true;
  }
  return method === "DELETE" && /^\/profiles\/[^/]+$/.test(normalizedPath);
}

function isForbiddenBrowserProxyMutation(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const candidate = params as { method?: unknown; path?: unknown };
  const method = (normalizeOptionalString(candidate.method) ?? "").toUpperCase();
  const path = normalizeOptionalString(candidate.path) ?? "";
  return Boolean(method && path && isPersistentBrowserProxyMutation(method, path));
}

async function resolveDirectNodePushConfig() {
  const auth = await resolveApnsAuthConfigFromEnv(process.env);
  return auth.ok
    ? { auth: auth.value, ok: true as const }
    : { error: auth.error, ok: false as const };
}

function resolveRelayNodePushConfig() {
  const relay = resolveApnsRelayConfigFromEnv(process.env, loadConfig().gateway);
  return relay.ok
    ? { ok: true as const, relayConfig: relay.value }
    : { error: relay.error, ok: false as const };
}

async function clearStaleApnsRegistrationIfNeeded(
  registration: NonNullable<Awaited<ReturnType<typeof loadApnsRegistration>>>,
  nodeId: string,
  params: { status: number; reason?: string },
) {
  if (
    !shouldClearStoredApnsRegistration({
      registration,
      result: params,
    })
  ) {
    return;
  }
  await clearApnsRegistrationIfCurrent({
    nodeId,
    registration,
  });
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isForegroundRestrictedIosCommand(command: string): boolean {
  return (
    command === "canvas.present" ||
    command === "canvas.navigate" ||
    command.startsWith("canvas.") ||
    command.startsWith("camera.") ||
    command.startsWith("screen.") ||
    command.startsWith("talk.")
  );
}

function shouldQueueAsPendingForegroundAction(params: {
  platform?: string;
  command: string;
  error: unknown;
}): boolean {
  const platform = normalizeLowercaseStringOrEmpty(params.platform);
  if (!platform.startsWith("ios") && !platform.startsWith("ipados")) {
    return false;
  }
  if (!isForegroundRestrictedIosCommand(params.command)) {
    return false;
  }
  const error =
    params.error && typeof params.error === "object"
      ? (params.error as { code?: unknown; message?: unknown })
      : null;
  const code = normalizeOptionalString(error?.code)?.toUpperCase() ?? "";
  const message = normalizeOptionalString(error?.message)?.toUpperCase() ?? "";
  return code === "NODE_BACKGROUND_UNAVAILABLE" || message.includes("BACKGROUND_UNAVAILABLE");
}

function prunePendingNodeActions(nodeId: string, nowMs: number): PendingNodeAction[] {
  const queue = pendingNodeActionsById.get(nodeId) ?? [];
  const minTimestampMs = nowMs - NODE_PENDING_ACTION_TTL_MS;
  const live = queue.filter((entry) => entry.enqueuedAtMs >= minTimestampMs);
  if (live.length === 0) {
    pendingNodeActionsById.delete(nodeId);
    return [];
  }
  pendingNodeActionsById.set(nodeId, live);
  return live;
}

function enqueuePendingNodeAction(params: {
  nodeId: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
}): PendingNodeAction {
  const nowMs = Date.now();
  const queue = prunePendingNodeActions(params.nodeId, nowMs);
  const existing = queue.find((entry) => entry.idempotencyKey === params.idempotencyKey);
  if (existing) {
    return existing;
  }
  const entry: PendingNodeAction = {
    command: params.command,
    enqueuedAtMs: nowMs,
    id: randomUUID(),
    idempotencyKey: params.idempotencyKey,
    nodeId: params.nodeId,
    paramsJSON: params.paramsJSON,
  };
  queue.push(entry);
  if (queue.length > NODE_PENDING_ACTION_MAX_PER_NODE) {
    queue.splice(0, queue.length - NODE_PENDING_ACTION_MAX_PER_NODE);
  }
  pendingNodeActionsById.set(params.nodeId, queue);
  return entry;
}

function listPendingNodeActions(nodeId: string): PendingNodeAction[] {
  return prunePendingNodeActions(nodeId, Date.now());
}

function resolveAllowedPendingNodeActions(params: {
  nodeId: string;
  client: { connect?: ConnectParams | null } | null;
}): PendingNodeAction[] {
  const pending = listPendingNodeActions(params.nodeId);
  if (pending.length === 0) {
    return pending;
  }
  const connect = params.client?.connect;
  const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
  const allowlist = resolveNodeCommandAllowlist(loadConfig(), {
    deviceFamily: connect?.client?.deviceFamily,
    platform: connect?.client?.platform,
  });
  const allowed = pending.filter((entry) => {
    const result = isNodeCommandAllowed({
      allowlist,
      command: entry.command,
      declaredCommands,
    });
    return result.ok;
  });
  if (allowed.length !== pending.length) {
    if (allowed.length === 0) {
      pendingNodeActionsById.delete(params.nodeId);
    } else {
      pendingNodeActionsById.set(params.nodeId, allowed);
    }
  }
  return allowed;
}

function ackPendingNodeActions(nodeId: string, ids: string[]): PendingNodeAction[] {
  if (ids.length === 0) {
    return listPendingNodeActions(nodeId);
  }
  const pending = prunePendingNodeActions(nodeId, Date.now());
  const idSet = new Set(ids);
  const remaining = pending.filter((entry) => !idSet.has(entry.id));
  if (remaining.length === 0) {
    pendingNodeActionsById.delete(nodeId);
    return [];
  }
  pendingNodeActionsById.set(nodeId, remaining);
  return remaining;
}

function toPendingParamsJSON(params: unknown): string | undefined {
  if (params === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(params);
  } catch {
    return undefined;
  }
}

export async function maybeWakeNodeWithApns(
  nodeId: string,
  opts?: { force?: boolean; wakeReason?: string },
): Promise<NodeWakeAttempt> {
  const state = nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 };
  nodeWakeById.set(nodeId, state);

  if (state.inFlight) {
    return await state.inFlight;
  }

  const now = Date.now();
  const force = opts?.force === true;
  if (!force && state.lastWakeAtMs > 0 && now - state.lastWakeAtMs < NODE_WAKE_THROTTLE_MS) {
    return { available: true, durationMs: 0, path: "throttled", throttled: true };
  }

  state.inFlight = (async () => {
    const startedAtMs = Date.now();
    const withDuration = (attempt: Omit<NodeWakeAttempt, "durationMs">): NodeWakeAttempt => ({
      ...attempt,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });

    try {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        return withDuration({ available: false, path: "no-registration", throttled: false });
      }

      let wakeResult;
      if (registration.transport === "relay") {
        const relay = resolveRelayNodePushConfig();
        if (!relay.ok) {
          return withDuration({
            apnsReason: relay.error,
            available: false,
            path: "no-auth",
            throttled: false,
          });
        }
        state.lastWakeAtMs = Date.now();
        wakeResult = await sendApnsBackgroundWake({
          nodeId,
          registration,
          relayConfig: relay.relayConfig,
          wakeReason: opts?.wakeReason ?? "node.invoke",
        });
      } else {
        const auth = await resolveDirectNodePushConfig();
        if (!auth.ok) {
          return withDuration({
            apnsReason: auth.error,
            available: false,
            path: "no-auth",
            throttled: false,
          });
        }
        state.lastWakeAtMs = Date.now();
        wakeResult = await sendApnsBackgroundWake({
          auth: auth.auth,
          nodeId,
          registration,
          wakeReason: opts?.wakeReason ?? "node.invoke",
        });
      }
      await clearStaleApnsRegistrationIfNeeded(registration, nodeId, wakeResult);
      if (!wakeResult.ok) {
        return withDuration({
          apnsReason: wakeResult.reason,
          apnsStatus: wakeResult.status,
          available: true,
          path: "send-error",
          throttled: false,
        });
      }
      return withDuration({
        apnsReason: wakeResult.reason,
        apnsStatus: wakeResult.status,
        available: true,
        path: "sent",
        throttled: false,
      });
    } catch (error) {
      // Best-effort wake only.
      const message = formatErrorMessage(error);
      if (state.lastWakeAtMs === 0) {
        return withDuration({
          apnsReason: message,
          available: false,
          path: "send-error",
          throttled: false,
        });
      }
      return withDuration({
        apnsReason: message,
        available: true,
        path: "send-error",
        throttled: false,
      });
    }
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = undefined;
  }
}

export async function maybeSendNodeWakeNudge(nodeId: string): Promise<NodeWakeNudgeAttempt> {
  const startedAtMs = Date.now();
  const withDuration = (
    attempt: Omit<NodeWakeNudgeAttempt, "durationMs">,
  ): NodeWakeNudgeAttempt => ({
    ...attempt,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  const lastNudgeAtMs = nodeWakeNudgeById.get(nodeId) ?? 0;
  if (lastNudgeAtMs > 0 && Date.now() - lastNudgeAtMs < NODE_WAKE_NUDGE_THROTTLE_MS) {
    return withDuration({ reason: "throttled", sent: false, throttled: true });
  }

  const registration = await loadApnsRegistration(nodeId);
  if (!registration) {
    return withDuration({ reason: "no-registration", sent: false, throttled: false });
  }
  try {
    let result;
    if (registration.transport === "relay") {
      const relay = resolveRelayNodePushConfig();
      if (!relay.ok) {
        return withDuration({
          apnsReason: relay.error,
          reason: "no-auth",
          sent: false,
          throttled: false,
        });
      }
      result = await sendApnsAlert({
        body: "Tap to reopen OpenClaw and restore the node connection.",
        nodeId,
        registration,
        relayConfig: relay.relayConfig,
        title: "OpenClaw needs a quick reopen",
      });
    } else {
      const auth = await resolveDirectNodePushConfig();
      if (!auth.ok) {
        return withDuration({
          apnsReason: auth.error,
          reason: "no-auth",
          sent: false,
          throttled: false,
        });
      }
      result = await sendApnsAlert({
        auth: auth.auth,
        body: "Tap to reopen OpenClaw and restore the node connection.",
        nodeId,
        registration,
        title: "OpenClaw needs a quick reopen",
      });
    }
    await clearStaleApnsRegistrationIfNeeded(registration, nodeId, result);
    if (!result.ok) {
      return withDuration({
        apnsReason: result.reason,
        apnsStatus: result.status,
        reason: "apns-not-ok",
        sent: false,
        throttled: false,
      });
    }
    nodeWakeNudgeById.set(nodeId, Date.now());
    return withDuration({
      apnsReason: result.reason,
      apnsStatus: result.status,
      reason: "sent",
      sent: true,
      throttled: false,
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    return withDuration({
      apnsReason: message,
      reason: "send-error",
      sent: false,
      throttled: false,
    });
  }
}

export async function waitForNodeReconnect(params: {
  nodeId: string;
  context: { nodeRegistry: { get: (nodeId: string) => unknown } };
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const timeoutMs = Math.max(250, params.timeoutMs ?? NODE_WAKE_RECONNECT_WAIT_MS);
  const pollMs = Math.max(50, params.pollMs ?? NODE_WAKE_RECONNECT_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (params.context.nodeRegistry.get(params.nodeId)) {
      return true;
    }
    await delayMs(pollMs);
  }
  return Boolean(params.context.nodeRegistry.get(params.nodeId));
}

export const nodeHandlers: GatewayRequestHandlers = {
  "node.canvas.capability.refresh": async ({ params, respond, client }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        method: "node.canvas.capability.refresh",
        respond,
        validator: validateNodeListParams,
      });
      return;
    }
    const baseCanvasHostUrl = normalizeOptionalString(client?.canvasHostUrl) ?? "";
    if (!baseCanvasHostUrl) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "canvas host unavailable for this node session"),
      );
      return;
    }

    const canvasCapability = mintCanvasCapabilityToken();
    const canvasCapabilityExpiresAtMs = Date.now() + CANVAS_CAPABILITY_TTL_MS;
    const scopedCanvasHostUrl = buildCanvasScopedHostUrl(baseCanvasHostUrl, canvasCapability);
    if (!scopedCanvasHostUrl) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to mint scoped canvas host URL"),
      );
      return;
    }

    if (client) {
      client.canvasCapability = canvasCapability;
      client.canvasCapabilityExpiresAtMs = canvasCapabilityExpiresAtMs;
    }
    respond(
      true,
      {
        canvasCapability,
        canvasCapabilityExpiresAtMs,
        canvasHostUrl: scopedCanvasHostUrl,
      },
      undefined,
    );
  },
  "node.describe": async ({ params, respond, context }) => {
    if (!validateNodeDescribeParams(params)) {
      respondInvalidParams({
        method: "node.describe",
        respond,
        validator: validateNodeDescribeParams,
      });
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = normalizeOptionalString(String(nodeId ?? "")) ?? "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const [devicePairing, nodePairing] = await Promise.all([
        listDevicePairing(),
        listNodePairing(),
      ]);
      const catalog = createKnownNodeCatalog({
        connectedNodes: context.nodeRegistry.listConnected(),
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
      });
      const node = getKnownNode(catalog, id);
      if (!node) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { ts: Date.now(), ...node }, undefined);
    });
  },
  "node.event": async ({ params, respond, context, client }) => {
    if (!validateNodeEventParams(params)) {
      respondInvalidParams({
        method: "node.event",
        respond,
        validator: validateNodeEventParams,
      });
      return;
    }
    const p = params as { event: string; payload?: unknown; payloadJSON?: string | null };
    const payloadJSON =
      typeof p.payloadJSON === "string"
        ? p.payloadJSON
        : p.payload !== undefined
          ? JSON.stringify(p.payload)
          : null;
    await respondUnavailableOnThrow(respond, async () => {
      const { handleNodeEvent } = await import("../server-node-events.js");
      const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
      const nodeContext = {
        addChatRun: context.addChatRun,
        agentRunSeq: context.agentRunSeq,
        broadcast: context.broadcast,
        broadcastVoiceWakeChanged: context.broadcastVoiceWakeChanged,
        chatAbortControllers: context.chatAbortControllers,
        chatAbortedRuns: context.chatAbortedRuns,
        chatDeltaSentAt: context.chatDeltaSentAt,
        chatRunBuffers: context.chatRunBuffers,
        dedupe: context.dedupe,
        deps: context.deps,
        getHealthCache: context.getHealthCache,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        logGateway: { warn: context.logGateway.warn },
        nodeSendToSession: context.nodeSendToSession,
        nodeSubscribe: context.nodeSubscribe,
        nodeUnsubscribe: context.nodeUnsubscribe,
        refreshHealthSnapshot: context.refreshHealthSnapshot,
        removeChatRun: context.removeChatRun,
      };
      await handleNodeEvent(nodeContext, nodeId, {
        event: p.event,
        payloadJSON,
      });
      respond(true, { ok: true }, undefined);
    });
  },
  "node.invoke": async ({ params, respond, context, client, req }) => {
    if (!validateNodeInvokeParams(params)) {
      respondInvalidParams({
        method: "node.invoke",
        respond,
        validator: validateNodeInvokeParams,
      });
      return;
    }
    const p = params as {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const nodeId = normalizeOptionalString(String(p.nodeId ?? "")) ?? "";
    const command = normalizeOptionalString(String(p.command ?? "")) ?? "";
    if (!nodeId || !command) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command required"),
      );
      return;
    }
    if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*",
          { details: { command } },
        ),
      );
      return;
    }
    if (command === "browser.proxy" && isForbiddenBrowserProxyMutation(p.params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke cannot mutate persistent browser profiles via browser.proxy",
          { details: { command } },
        ),
      );
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      let nodeSession = context.nodeRegistry.get(nodeId);
      if (!nodeSession) {
        const wakeReqId = req.id;
        const wakeFlowStartedAtMs = Date.now();
        context.logGateway.info(
          `node wake start node=${nodeId} req=${wakeReqId} command=${command}`,
        );

        const wake = await maybeWakeNodeWithApns(nodeId);
        context.logGateway.info(
          `node wake stage=wake1 node=${nodeId} req=${wakeReqId} ` +
            `available=${wake.available} throttled=${wake.throttled} ` +
            `path=${wake.path} durationMs=${wake.durationMs} ` +
            `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
        );
        if (wake.available) {
          const waitStartedAtMs = Date.now();
          const waitTimeoutMs = NODE_WAKE_RECONNECT_WAIT_MS;
          const reconnected = await waitForNodeReconnect({
            context,
            nodeId,
            timeoutMs: waitTimeoutMs,
          });
          const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
          context.logGateway.info(
            `node wake stage=wait1 node=${nodeId} req=${wakeReqId} ` +
              `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
          );
        }
        nodeSession = context.nodeRegistry.get(nodeId);
        if (!nodeSession && wake.available) {
          const retryWake = await maybeWakeNodeWithApns(nodeId, { force: true });
          context.logGateway.info(
            `node wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true ` +
              `available=${retryWake.available} throttled=${retryWake.throttled} ` +
              `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
              `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
          );
          if (retryWake.available) {
            const waitStartedAtMs = Date.now();
            const waitTimeoutMs = NODE_WAKE_RECONNECT_RETRY_WAIT_MS;
            const reconnected = await waitForNodeReconnect({
              context,
              nodeId,
              timeoutMs: waitTimeoutMs,
            });
            const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
            context.logGateway.info(
              `node wake stage=wait2 node=${nodeId} req=${wakeReqId} ` +
                `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
            );
          }
          nodeSession = context.nodeRegistry.get(nodeId);
        }
        if (!nodeSession) {
          const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
          const nudge = await maybeSendNodeWakeNudge(nodeId);
          context.logGateway.info(
            `node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
              `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
              `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
          );
          context.logGateway.warn(
            `node wake done node=${nodeId} req=${wakeReqId} connected=false ` +
              `reason=not_connected totalMs=${totalDurationMs}`,
          );
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "node not connected", {
              details: { code: "NOT_CONNECTED" },
            }),
          );
          return;
        }

        const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
        context.logGateway.info(
          `node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`,
        );
      }
      const cfg = loadConfig();
      const allowlist = resolveNodeCommandAllowlist(cfg, nodeSession);
      const allowed = isNodeCommandAllowed({
        allowlist,
        command,
        declaredCommands: nodeSession.commands,
      });
      if (!allowed.ok) {
        const hint = buildNodeCommandRejectionHint(allowed.reason, command, nodeSession);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, hint, {
            details: { command, reason: allowed.reason },
          }),
        );
        return;
      }
      const forwardedParams = sanitizeNodeInvokeParamsForForwarding({
        client,
        command,
        execApprovalManager: context.execApprovalManager,
        nodeId,
        rawParams: p.params,
      });
      if (!forwardedParams.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, forwardedParams.message, {
            details: forwardedParams.details ?? null,
          }),
        );
        return;
      }
      const res = await context.nodeRegistry.invoke({
        command,
        idempotencyKey: p.idempotencyKey,
        nodeId,
        params: forwardedParams.params,
        timeoutMs: p.timeoutMs,
      });
      if (!res.ok) {
        if (
          shouldQueueAsPendingForegroundAction({
            command,
            error: res.error,
            platform: nodeSession.platform,
          })
        ) {
          const paramsJSON = toPendingParamsJSON(forwardedParams.params);
          const queued = enqueuePendingNodeAction({
            command,
            idempotencyKey: p.idempotencyKey,
            nodeId,
            paramsJSON,
          });
          const wake = await maybeWakeNodeWithApns(nodeId);
          context.logGateway.info(
            `node pending queued node=${nodeId} req=${req.id} command=${command} ` +
              `queuedId=${queued.id} wakePath=${wake.path} wakeAvailable=${wake.available}`,
          );
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              "node command queued until iOS returns to foreground",
              {
                details: {
                  code: "QUEUED_UNTIL_FOREGROUND",
                  command,
                  nodeError: res.error ?? null,
                  nodeId,
                  queuedActionId: queued.id,
                  wake: {
                    apnsReason: wake.apnsReason,
                    apnsStatus: wake.apnsStatus,
                    available: wake.available,
                    path: wake.path,
                    throttled: wake.throttled,
                  },
                },
                retryable: true,
              },
            ),
          );
          return;
        }
        if (!respondUnavailableOnNodeInvokeError(respond, res)) {
          return;
        }
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
      respond(
        true,
        {
          command,
          nodeId,
          ok: true,
          payload,
          payloadJSON: res.payloadJSON ?? null,
        },
        undefined,
      );
    });
  },
  "node.invoke.result": handleNodeInvokeResult,
  "node.list": async ({ params, respond, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        method: "node.list",
        respond,
        validator: validateNodeListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const [devicePairing, nodePairing] = await Promise.all([
        listDevicePairing(),
        listNodePairing(),
      ]);
      const catalog = createKnownNodeCatalog({
        connectedNodes: context.nodeRegistry.listConnected(),
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
      });
      const nodes = listKnownNodes(catalog);
      respond(true, { nodes, ts: Date.now() }, undefined);
    });
  },
  "node.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateNodePairApproveParams(params)) {
      respondInvalidParams({
        method: "node.pair.approve",
        respond,
        validator: validateNodePairApproveParams,
      });
      return;
    }
    const { requestId } = params as { requestId: string };
    // Intentionally fail closed for RPC callers without an explicit scoped session.
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    await respondUnavailableOnThrow(respond, async () => {
      const approved = await approveNodePairing(requestId, { callerScopes });
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      if ("status" in approved && approved.status === "forbidden") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${approved.missingScope}`),
        );
        return;
      }
      if (!("node" in approved)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      const approvedNode = approved.node;
      context.broadcast(
        "node.pair.resolved",
        {
          decision: "approved",
          nodeId: approvedNode.nodeId,
          requestId,
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, approved, undefined);
    });
  },
  "node.pair.list": async ({ params, respond }) => {
    if (!validateNodePairListParams(params)) {
      respondInvalidParams({
        method: "node.pair.list",
        respond,
        validator: validateNodePairListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listNodePairing();
      respond(true, list, undefined);
    });
  },
  "node.pair.reject": async ({ params, respond, context }) => {
    if (!validateNodePairRejectParams(params)) {
      respondInvalidParams({
        method: "node.pair.reject",
        respond,
        validator: validateNodePairRejectParams,
      });
      return;
    }
    const { requestId } = params as { requestId: string };
    await respondUnavailableOnThrow(respond, async () => {
      const rejected = await rejectNodePairing(requestId);
      if (!rejected) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      context.broadcast(
        "node.pair.resolved",
        {
          decision: "rejected",
          nodeId: rejected.nodeId,
          requestId,
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, rejected, undefined);
    });
  },
  "node.pair.request": async ({ params, respond, context }) => {
    if (!validateNodePairRequestParams(params)) {
      respondInvalidParams({
        method: "node.pair.request",
        respond,
        validator: validateNodePairRequestParams,
      });
      return;
    }
    const p = params as Parameters<typeof requestNodePairing>[0];
    await respondUnavailableOnThrow(respond, async () => {
      const result = await requestNodePairing({
        caps: p.caps,
        commands: p.commands,
        coreVersion: p.coreVersion,
        deviceFamily: p.deviceFamily,
        displayName: p.displayName,
        modelIdentifier: p.modelIdentifier,
        nodeId: p.nodeId,
        permissions: p.permissions,
        platform: p.platform,
        remoteIp: p.remoteIp,
        silent: p.silent,
        uiVersion: p.uiVersion,
        version: p.version,
      });
      if (result.status === "pending" && result.created) {
        context.broadcast("node.pair.requested", result.request, {
          dropIfSlow: true,
        });
      }
      respond(true, result, undefined);
    });
  },
  "node.pair.verify": async ({ params, respond }) => {
    if (!validateNodePairVerifyParams(params)) {
      respondInvalidParams({
        method: "node.pair.verify",
        respond,
        validator: validateNodePairVerifyParams,
      });
      return;
    }
    const { nodeId, token } = params as {
      nodeId: string;
      token: string;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const result = await verifyNodeToken(nodeId, token);
      respond(true, result, undefined);
    });
  },
  "node.pending.ack": async ({ params, respond, client }) => {
    if (!validateNodePendingAckParams(params)) {
      respondInvalidParams({
        method: "node.pending.ack",
        respond,
        validator: validateNodePendingAckParams,
      });
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(String(nodeId ?? "")) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const ackIds = [
      ...new Set(
        (params.ids ?? [])
          .map((value) => normalizeOptionalString(String(value ?? "")) ?? "")
          .filter(Boolean),
      ),
    ];
    const remaining = ackPendingNodeActions(trimmedNodeId, ackIds);
    respond(
      true,
      {
        ackedIds: ackIds,
        nodeId: trimmedNodeId,
        remainingCount: remaining.length,
      },
      undefined,
    );
  },
  "node.pending.pull": async ({ params, respond, client }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        method: "node.pending.pull",
        respond,
        validator: validateNodeListParams,
      });
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(String(nodeId ?? "")) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const pending = resolveAllowedPendingNodeActions({ client, nodeId: trimmedNodeId });
    respond(
      true,
      {
        actions: pending.map((entry) => ({
          id: entry.id,
          command: entry.command,
          paramsJSON: entry.paramsJSON ?? null,
          enqueuedAtMs: entry.enqueuedAtMs,
        })),
        nodeId: trimmedNodeId,
      },
      undefined,
    );
  },
  "node.rename": async ({ params, respond }) => {
    if (!validateNodeRenameParams(params)) {
      respondInvalidParams({
        method: "node.rename",
        respond,
        validator: validateNodeRenameParams,
      });
      return;
    }
    const { nodeId, displayName } = params as {
      nodeId: string;
      displayName: string;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const trimmed = displayName.trim();
      if (!trimmed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"));
        return;
      }
      const updated = await renamePairedNode(nodeId, trimmed);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { displayName: updated.displayName, nodeId: updated.nodeId }, undefined);
    });
  },
};

function buildNodeCommandRejectionHint(
  reason: string,
  command: string,
  node: { platform?: string } | undefined,
): string {
  const platform = node?.platform ?? "unknown";
  if (reason === "command not declared by node") {
    return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
  }
  if (reason === "command not allowlisted") {
    return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
  }
  if (reason === "node did not declare commands") {
    return `node command not allowed: the node did not declare any supported commands`;
  }
  return `node command not allowed: ${reason}`;
}
