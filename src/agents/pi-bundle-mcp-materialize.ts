import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logWarn } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  TOOL_NAME_SEPARATOR,
  buildSafeToolName,
  normalizeReservedToolNames,
} from "./pi-bundle-mcp-names.js";
import { createSessionMcpRuntime } from "./pi-bundle-mcp-runtime.js";
import type { BundleMcpToolRuntime, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content = Array.isArray(params.result.content)
    ? (params.result.content as AgentToolResult<unknown>["content"])
    : [];
  const normalizedContent: AgentToolResult<unknown>["content"] =
    content.length > 0
      ? content
      : (params.result.structuredContent !== undefined
        ? [
            {
              text: JSON.stringify(params.result.structuredContent, null, 2),
              type: "text",
            },
          ]
        : ([
            {
              text: JSON.stringify(
                {
                  status: params.result.isError === true ? "error" : "ok",
                  server: params.serverName,
                  tool: params.toolName,
                },
                null,
                2,
              ),
              type: "text",
            },
          ] as AgentToolResult<unknown>["content"]));
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  params.runtime.markUsed();
  const catalog = await params.runtime.getCatalog();
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: BundleMcpToolRuntime["tools"] = [];
  const sortedCatalogTools = [...catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const safeToolName = buildSafeToolName({
      reservedNames,
      serverName: tool.safeServerName,
      toolName: originalName,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    tools.push({
      description: tool.description || tool.fallbackDescription,
      execute: async (_toolCallId: string, input: unknown) => {
        const result = await params.runtime.callTool(tool.serverName, tool.toolName, input);
        return toAgentToolResult({
          result,
          serverName: tool.serverName,
          toolName: tool.toolName,
        });
      },
      label: tool.title ?? tool.toolName,
      name: safeToolName,
      parameters: tool.inputSchema,
    });
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // Turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    dispose: async () => {
      await params.disposeRuntime?.();
    },
    tools,
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleMcpToolRuntime> {
  const runtime = createSessionMcpRuntime({
    cfg: params.cfg,
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
  });
  const materialized = await materializeBundleMcpToolsForRun({
    disposeRuntime: async () => {
      await runtime.dispose();
    },
    reservedToolNames: params.reservedToolNames,
    runtime,
  });
  return materialized;
}
