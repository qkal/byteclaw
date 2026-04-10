import type { WebSocket } from "ws";
import type { ConnectParams } from "../protocol/index.js";

export interface GatewayWsClient {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  usesSharedGatewayAuth: boolean;
  sharedGatewaySessionGeneration?: string;
  presenceKey?: string;
  clientIp?: string;
  canvasHostUrl?: string;
  canvasCapability?: string;
  canvasCapabilityExpiresAtMs?: number;
}
