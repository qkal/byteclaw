import type { loadConfig } from "../config/config.js";
import {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import {
  type McpLoopbackTool,
  type McpToolSchemaEntry,
  buildMcpToolSchema,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const TOOL_CACHE_TTL_MS = 30_000;
const NATIVE_TOOL_EXCLUDE = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

interface CachedScopedTools {
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  configRef: ReturnType<typeof loadConfig>;
  time: number;
}

export class McpLoopbackToolCache {
  #entries = new Map<string, CachedScopedTools>();

  resolve(params: {
    cfg: ReturnType<typeof loadConfig>;
    sessionKey: string;
    messageProvider: string | undefined;
    accountId: string | undefined;
  }): CachedScopedTools {
    const cacheKey = [params.sessionKey, params.messageProvider ?? "", params.accountId ?? ""].join(
      "\u0000",
    );
    const now = Date.now();
    const cached = this.#entries.get(cacheKey);
    if (cached && cached.configRef === params.cfg && now - cached.time < TOOL_CACHE_TTL_MS) {
      return cached;
    }

    const next = resolveGatewayScopedTools({
      accountId: params.accountId,
      cfg: params.cfg,
      excludeToolNames: NATIVE_TOOL_EXCLUDE,
      messageProvider: params.messageProvider,
      sessionKey: params.sessionKey,
      surface: "loopback",
    });
    const nextEntry: CachedScopedTools = {
      configRef: params.cfg,
      time: now,
      toolSchema: buildMcpToolSchema(next.tools),
      tools: next.tools,
    };
    this.#entries.set(cacheKey, nextEntry);
    for (const [key, entry] of this.#entries) {
      if (now - entry.time >= TOOL_CACHE_TTL_MS) {
        this.#entries.delete(key);
      }
    }
    return nextEntry;
  }
}

export {
  clearActiveMcpLoopbackRuntime,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
};
