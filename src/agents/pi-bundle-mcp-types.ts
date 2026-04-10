import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./tools/common.js";

export interface BundleMcpToolRuntime {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
}

export interface McpServerCatalog {
  serverName: string;
  launchSummary: string;
  toolCount: number;
}

export interface McpCatalogTool {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  fallbackDescription: string;
}

export interface McpToolCatalog {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
}

export interface SessionMcpRuntime {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  getCatalog: () => Promise<McpToolCatalog>;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  dispose: () => Promise<void>;
}

export interface SessionMcpRuntimeManager {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  disposeAll: () => Promise<void>;
  listSessionIds: () => string[];
}
