import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import type { WebChannelHealthState, WebChannelStatus } from "./types.js";

function cloneStatus(status: WebChannelStatus): WebChannelStatus {
  return {
    ...status,
    lastDisconnect: status.lastDisconnect ? { ...status.lastDisconnect } : null,
  };
}

function isTerminalHealthState(healthState: WebChannelHealthState | undefined): boolean {
  return healthState === "conflict" || healthState === "logged-out" || healthState === "stopped";
}

export function createWebChannelStatusController(statusSink?: (status: WebChannelStatus) => void) {
  const status: WebChannelStatus = {
    connected: false,
    healthState: "starting",
    lastConnectedAt: null,
    lastDisconnect: null,
    lastError: null,
    lastEventAt: null,
    lastInboundAt: null,
    lastMessageAt: null,
    reconnectAttempts: 0,
    running: true,
  };

  const emit = () => {
    statusSink?.(cloneStatus(status));
  };

  return {
    emit,
    markStopped(at = Date.now()) {
      status.running = false;
      status.connected = false;
      status.lastEventAt = at;
      if (!isTerminalHealthState(status.healthState)) {
        status.healthState = "stopped";
      }
      emit();
    },
    noteClose(params: {
      at?: number;
      statusCode?: number;
      loggedOut?: boolean;
      error?: string;
      reconnectAttempts: number;
      healthState: WebChannelHealthState;
    }) {
      const at = params.at ?? Date.now();
      status.connected = false;
      status.lastEventAt = at;
      status.lastDisconnect = {
        at,
        error: params.error,
        loggedOut: Boolean(params.loggedOut),
        status: params.statusCode,
      };
      status.lastError = params.error ?? null;
      status.reconnectAttempts = params.reconnectAttempts;
      status.healthState = params.healthState;
      emit();
    },
    noteConnected(at = Date.now()) {
      Object.assign(status, createConnectedChannelStatusPatch(at));
      status.lastError = null;
      status.healthState = "healthy";
      emit();
    },
    noteInbound(at = Date.now()) {
      status.lastInboundAt = at;
      status.lastMessageAt = at;
      status.lastEventAt = at;
      if (status.connected) {
        status.healthState = "healthy";
      }
      emit();
    },
    noteReconnectAttempts(reconnectAttempts: number) {
      status.reconnectAttempts = reconnectAttempts;
      emit();
    },
    noteWatchdogStale(at = Date.now()) {
      status.lastEventAt = at;
      if (status.connected) {
        status.healthState = "stale";
      }
      emit();
    },
    snapshot: () => status,
  };
}
