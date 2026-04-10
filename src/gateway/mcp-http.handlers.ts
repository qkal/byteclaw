import crypto from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import {
  type JsonRpcRequest,
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcError,
  jsonRpcResult,
} from "./mcp-http.protocol.js";
import type { McpLoopbackTool, McpToolSchemaEntry } from "./mcp-http.schema.js";

interface McpTextContent {
  type: "text";
  text: string;
}

function normalizeToolCallContent(result: unknown): McpTextContent[] {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((block: { type?: string; text?: string }) => ({
      text: block.text ?? (typeof block === "string" ? block : JSON.stringify(block)),
      type: (block.type ?? "text") as "text",
    }));
  }
  return [
    {
      text: typeof result === "string" ? result : JSON.stringify(result),
      type: "text",
    },
  ];
}

export async function handleMcpJsonRpc(params: {
  message: JsonRpcRequest;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      const negotiated =
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        capabilities: { tools: {} },
        protocolVersion: negotiated,
        serverInfo: {
          name: MCP_LOOPBACK_SERVER_NAME,
          version: MCP_LOOPBACK_SERVER_VERSION,
        },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled": {
      return null;
    }
    case "tools/list": {
      return jsonRpcResult(id, { tools: params.toolSchema });
    }
    case "tools/call": {
      const toolName = methodParams?.name as string;
      const toolArgs = (methodParams?.arguments ?? {}) as Record<string, unknown>;
      const tool = params.tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ text: `Tool not available: ${toolName}`, type: "text" }],
          isError: true,
        });
      }
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      try {
        const result = await tool.execute(toolCallId, toolArgs);
        return jsonRpcResult(id, {
          content: normalizeToolCallContent(result),
          isError: false,
        });
      } catch (error) {
        const message = formatErrorMessage(error);
        return jsonRpcResult(id, {
          content: [{ text: message || "tool execution failed", type: "text" }],
          isError: true,
        });
      }
    }
    default: {
      return jsonRpcError(id, -32_601, `Method not found: ${method}`);
    }
  }
}
