import { randomUUID } from "node:crypto";
import type { GatewayWsClient } from "./server/ws-types.js";

export interface NodeSession {
  nodeId: string;
  connId: string;
  client: GatewayWsClient;
  clientId?: string;
  clientMode?: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  connectedAtMs: number;
}

interface PendingInvoke {
  nodeId: string;
  command: string;
  resolve: (value: NodeInvokeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface NodeInvokeResult {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string } | null;
}

export class NodeRegistry {
  private nodesById = new Map<string, NodeSession>();
  private nodesByConn = new Map<string, string>();
  private pendingInvokes = new Map<string, PendingInvoke>();

  register(client: GatewayWsClient, opts: { remoteIp?: string | undefined }) {
    const { connect } = client;
    const nodeId = connect.device?.id ?? connect.client.id;
    const caps = Array.isArray(connect.caps) ? connect.caps : [];
    const commands = Array.isArray((connect as { commands?: string[] }).commands)
      ? ((connect as { commands?: string[] }).commands ?? [])
      : [];
    const permissions =
      typeof (connect as { permissions?: Record<string, boolean> }).permissions === "object"
        ? ((connect as { permissions?: Record<string, boolean> }).permissions ?? undefined)
        : undefined;
    const pathEnv =
      typeof (connect as { pathEnv?: string }).pathEnv === "string"
        ? (connect as { pathEnv?: string }).pathEnv
        : undefined;
    const session: NodeSession = {
      caps,
      client,
      clientId: connect.client.id,
      clientMode: connect.client.mode,
      commands,
      connId: client.connId,
      connectedAtMs: Date.now(),
      coreVersion: (connect as { coreVersion?: string }).coreVersion,
      deviceFamily: connect.client.deviceFamily,
      displayName: connect.client.displayName,
      modelIdentifier: connect.client.modelIdentifier,
      nodeId,
      pathEnv,
      permissions,
      platform: connect.client.platform,
      remoteIp: opts.remoteIp,
      uiVersion: (connect as { uiVersion?: string }).uiVersion,
      version: connect.client.version,
    };
    this.nodesById.set(nodeId, session);
    this.nodesByConn.set(client.connId, nodeId);
    return session;
  }

  unregister(connId: string): string | null {
    const nodeId = this.nodesByConn.get(connId);
    if (!nodeId) {
      return null;
    }
    this.nodesByConn.delete(connId);
    this.nodesById.delete(nodeId);
    for (const [id, pending] of this.pendingInvokes.entries()) {
      if (pending.nodeId !== nodeId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(new Error(`node disconnected (${pending.command})`));
      this.pendingInvokes.delete(id);
    }
    return nodeId;
  }

  listConnected(): NodeSession[] {
    return [...this.nodesById.values()];
  }

  get(nodeId: string): NodeSession | undefined {
    return this.nodesById.get(nodeId);
  }

  async invoke(params: {
    nodeId: string;
    command: string;
    params?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<NodeInvokeResult> {
    const node = this.nodesById.get(params.nodeId);
    if (!node) {
      return {
        error: { code: "NOT_CONNECTED", message: "node not connected" },
        ok: false,
      };
    }
    const requestId = randomUUID();
    const payload = {
      command: params.command,
      id: requestId,
      idempotencyKey: params.idempotencyKey,
      nodeId: params.nodeId,
      paramsJSON:
        "params" in params && params.params !== undefined ? JSON.stringify(params.params) : null,
      timeoutMs: params.timeoutMs,
    };
    const ok = this.sendEventToSession(node, "node.invoke.request", payload);
    if (!ok) {
      return {
        error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
        ok: false,
      };
    }
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30_000;
    return await new Promise<NodeInvokeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        resolve({
          error: { code: "TIMEOUT", message: "node invoke timed out" },
          ok: false,
        });
      }, timeoutMs);
      this.pendingInvokes.set(requestId, {
        command: params.command,
        nodeId: params.nodeId,
        reject,
        resolve,
        timer,
      });
    });
  }

  handleInvokeResult(params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  }): boolean {
    const pending = this.pendingInvokes.get(params.id);
    if (!pending) {
      return false;
    }
    if (pending.nodeId !== params.nodeId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingInvokes.delete(params.id);
    pending.resolve({
      error: params.error ?? null,
      ok: params.ok,
      payload: params.payload,
      payloadJSON: params.payloadJSON ?? null,
    });
    return true;
  }

  sendEvent(nodeId: string, event: string, payload?: unknown): boolean {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return false;
    }
    return this.sendEventToSession(node, event, payload);
  }

  private sendEventInternal(node: NodeSession, event: string, payload: unknown): boolean {
    try {
      node.client.socket.send(
        JSON.stringify({
          event,
          payload,
          type: "event",
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private sendEventToSession(node: NodeSession, event: string, payload: unknown): boolean {
    return this.sendEventInternal(node, event, payload);
  }
}
