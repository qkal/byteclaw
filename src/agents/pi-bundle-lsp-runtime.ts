import { type ChildProcess, spawn } from "node:child_process";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logWarn } from "../logger.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { loadEmbeddedPiLspConfig } from "./embedded-pi-lsp.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";
import type { AnyAgentTool } from "./tools/common.js";

// Minimal LSP JSON-RPC framing over stdio (Content-Length header + JSON body).

interface LspSession {
  serverName: string;
  process: ChildProcess;
  requestId: number;
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  initialized: boolean;
  capabilities: LspServerCapabilities;
}

interface LspServerCapabilities {
  hoverProvider?: boolean;
  completionProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  diagnosticProvider?: boolean;
  [key: string]: unknown;
}

export interface BundleLspToolRuntime {
  tools: AnyAgentTool[];
  sessions: { serverName: string; capabilities: LspServerCapabilities }[];
  dispose: () => Promise<void>;
}

interface LspPositionParams {
  uri: string;
  line: number;
  character: number;
}

function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function parseLspMessages(buffer: string): { messages: unknown[]; remaining: string } {
  const messages: unknown[] = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      break;
    }

    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      remaining = remaining.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (Buffer.byteLength(remaining.slice(bodyStart), "utf8") < contentLength) {
      break;
    }

    try {
      const body = remaining.slice(bodyStart, bodyStart + contentLength);
      messages.push(JSON.parse(body));
    } catch {
      // Skip malformed
    }
    remaining = remaining.slice(bodyEnd);
  }

  return { messages, remaining };
}

function sendRequest(session: LspSession, method: string, params?: unknown): Promise<unknown> {
  const id = ++session.requestId;
  return new Promise((resolve, reject) => {
    session.pendingRequests.set(id, { reject, resolve });
    const message = { id, jsonrpc: "2.0", method, params };
    const encoded = encodeLspMessage(message);
    session.process.stdin?.write(encoded, "utf8");

    // Timeout after 10 seconds
    setTimeout(() => {
      if (session.pendingRequests.has(id)) {
        session.pendingRequests.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }
    }, 10_000);
  });
}

function handleIncomingData(session: LspSession, chunk: string) {
  session.buffer += chunk;
  const { messages, remaining } = parseLspMessages(session.buffer);
  session.buffer = remaining;

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }
    const record = msg as Record<string, unknown>;

    if ("id" in record && typeof record.id === "number") {
      const pending = session.pendingRequests.get(record.id);
      if (pending) {
        session.pendingRequests.delete(record.id);
        if ("error" in record) {
          pending.reject(new Error(JSON.stringify(record.error)));
        } else {
          pending.resolve(record.result);
        }
      }
    }
    // Notifications (no id) are logged but not acted on
    if ("method" in record && !("id" in record)) {
      logDebug(`bundle-lsp:${session.serverName}: notification ${String(record.method)}`);
    }
  }
}

async function initializeSession(session: LspSession): Promise<LspServerCapabilities> {
  const result = (await sendRequest(session, "initialize", {
    capabilities: {
      textDocument: {
        completion: { completionItem: { snippetSupport: false } },
        definition: {},
        hover: { contentFormat: ["plaintext", "markdown"] },
        references: {},
      },
    },
    processId: process.pid,
    rootUri: null,
  })) as { capabilities?: LspServerCapabilities } | undefined;

  // Send initialized notification
  session.process.stdin?.write(
    encodeLspMessage({ jsonrpc: "2.0", method: "initialized", params: {} }),
    "utf8",
  );

  session.initialized = true;
  return result?.capabilities ?? {};
}

async function disposeSession(session: LspSession) {
  if (session.initialized) {
    try {
      await sendRequest(session, "shutdown").catch(() => {});
      session.process.stdin?.write(
        encodeLspMessage({ jsonrpc: "2.0", method: "exit", params: null }),
        "utf8",
      );
    } catch {
      // Best-effort
    }
  }
  for (const [, pending] of session.pendingRequests) {
    pending.reject(new Error("LSP session disposed"));
  }
  session.pendingRequests.clear();
  session.process.kill();
}

function createLspPositionTool(params: {
  session: LspSession;
  toolName: string;
  label: string;
  description: string;
  method: string;
  resultLabel: string;
}): AnyAgentTool {
  return {
    description: params.description,
    execute: async (_toolCallId, input) => {
      const position = input as LspPositionParams;
      const result = await sendRequest(params.session, params.method, {
        position: { character: position.character, line: position.line },
        textDocument: { uri: position.uri },
      });
      return formatLspResult(params.session.serverName, params.resultLabel, result);
    },
    label: params.label,
    name: params.toolName,
    parameters: {
      properties: {
        character: { description: "Zero-based character offset", type: "number" },
        line: { description: "Zero-based line number", type: "number" },
        uri: { description: "File URI (file:///path/to/file)", type: "string" },
      },
      required: ["uri", "line", "character"],
      type: "object",
    },
  };
}

function buildLspTools(session: LspSession): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  const caps = session.capabilities;
  const serverLabel = session.serverName;

  if (caps.hoverProvider) {
    tools.push(
      createLspPositionTool({
        description: `Get hover information for a symbol at a position in a file via the ${serverLabel} language server.`,
        label: `LSP Hover (${serverLabel})`,
        method: "textDocument/hover",
        resultLabel: "hover",
        session,
        toolName: `lsp_hover_${serverLabel}`,
      }),
    );
  }

  if (caps.definitionProvider) {
    tools.push(
      createLspPositionTool({
        description: `Find the definition of a symbol at a position in a file via the ${serverLabel} language server.`,
        label: `LSP Go to Definition (${serverLabel})`,
        method: "textDocument/definition",
        resultLabel: "definition",
        session,
        toolName: `lsp_definition_${serverLabel}`,
      }),
    );
  }

  if (caps.referencesProvider) {
    tools.push({
      description: `Find all references to a symbol at a position in a file via the ${serverLabel} language server.`,
      execute: async (_toolCallId, input) => {
        const params = input as {
          uri: string;
          line: number;
          character: number;
          includeDeclaration?: boolean;
        };
        const result = await sendRequest(session, "textDocument/references", {
          context: { includeDeclaration: params.includeDeclaration ?? true },
          position: { character: params.character, line: params.line },
          textDocument: { uri: params.uri },
        });
        return formatLspResult(serverLabel, "references", result);
      },
      label: `LSP Find References (${serverLabel})`,
      name: `lsp_references_${serverLabel}`,
      parameters: {
        properties: {
          character: { description: "Zero-based character offset", type: "number" },
          includeDeclaration: {
            description: "Include the declaration in results",
            type: "boolean",
          },
          line: { description: "Zero-based line number", type: "number" },
          uri: { description: "File URI (file:///path/to/file)", type: "string" },
        },
        required: ["uri", "line", "character"],
        type: "object",
      },
    });
  }

  return tools;
}

function formatLspResult(
  serverName: string,
  method: string,
  result: unknown,
): AgentToolResult<unknown> {
  const text =
    result !== null && result !== undefined
      ? JSON.stringify(result, null, 2)
      : `No ${method} result from ${serverName}`;
  return {
    content: [{ text, type: "text" }],
    details: { lspMethod: method, lspServer: serverName },
  };
}

export async function createBundleLspToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleLspToolRuntime> {
  const loaded = loadEmbeddedPiLspConfig({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  for (const diagnostic of loaded.diagnostics) {
    logWarn(`bundle-lsp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  // Skip spawning when no LSP servers are configured.
  if (Object.keys(loaded.lspServers).length === 0) {
    return { dispose: async () => {}, sessions: [], tools: [] };
  }

  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) =>
      normalizeOptionalLowercaseString(name),
    ).filter(Boolean),
  );
  const sessions: LspSession[] = [];
  const tools: AnyAgentTool[] = [];

  try {
    for (const [serverName, rawServer] of Object.entries(loaded.lspServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(rawServer);
      if (!launch.ok) {
        logWarn(`bundle-lsp: skipped server "${serverName}" because ${launch.reason}.`);
        continue;
      }
      const launchConfig = launch.config;

      try {
        const child = spawn(launchConfig.command, launchConfig.args ?? [], {
          cwd: launchConfig.cwd,
          env: { ...process.env, ...launchConfig.env },
          stdio: ["pipe", "pipe", "pipe"],
        });

        const session: LspSession = {
          buffer: "",
          capabilities: {},
          initialized: false,
          pendingRequests: new Map(),
          process: child,
          requestId: 0,
          serverName,
        };

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => handleIncomingData(session, chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
            logDebug(`bundle-lsp:${serverName}: ${line.trim()}`);
          }
        });

        const capabilities = await initializeSession(session);
        session.capabilities = capabilities;
        sessions.push(session);

        const serverTools = buildLspTools(session);
        for (const tool of serverTools) {
          const normalizedName = normalizeOptionalLowercaseString(tool.name);
          if (!normalizedName) {
            continue;
          }
          if (reservedNames.has(normalizedName)) {
            logWarn(
              `bundle-lsp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`,
            );
            continue;
          }
          reservedNames.add(normalizedName);
          tools.push(tool);
        }

        logDebug(
          `bundle-lsp: started "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}) with ${serverTools.length} tools`,
        );
      } catch (error) {
        logWarn(
          `bundle-lsp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`,
        );
      }
    }

    return {
      dispose: async () => {
        await Promise.allSettled(sessions.map((session) => disposeSession(session)));
      },
      sessions: sessions.map((s) => ({
        capabilities: s.capabilities,
        serverName: s.serverName,
      })),
      tools,
    };
  } catch (error) {
    await Promise.allSettled(sessions.map((session) => disposeSession(session)));
    throw error;
  }
}
