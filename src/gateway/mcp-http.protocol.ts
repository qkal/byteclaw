export const MCP_LOOPBACK_SERVER_NAME = "openclaw";
export const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
export const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

export type JsonRpcId = string | number | null | undefined;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { id: id ?? null, jsonrpc: "2.0" as const, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { error: { code, message }, id: id ?? null, jsonrpc: "2.0" as const };
}
