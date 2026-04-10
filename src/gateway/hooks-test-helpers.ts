import type { IncomingMessage } from "node:http";
import type { HooksConfigResolved } from "./hooks.js";

export function createHooksConfig(): HooksConfigResolved {
  return {
    agentPolicy: {
      allowedAgentIds: undefined,
      defaultAgentId: "main",
      knownAgentIds: new Set(["main"]),
    },
    basePath: "/hooks",
    mappings: [],
    maxBodyBytes: 1024,
    sessionPolicy: {
      allowRequestSessionKey: false,
      allowedSessionKeyPrefixes: undefined,
      defaultSessionKey: undefined,
    },
    token: "hook-secret",
  };
}

export function createGatewayRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
  remoteAddress?: string;
  host?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: params.host ?? "localhost:18789",
    ...params.headers,
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  return {
    headers,
    method: params.method ?? "GET",
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
    url: params.path,
  } as IncomingMessage;
}
