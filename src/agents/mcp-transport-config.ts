import { logWarn } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  type HttpMcpTransportType,
  describeHttpMcpServerLaunchConfig,
  resolveHttpMcpServerLaunchConfig,
} from "./mcp-http.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";

export type McpTransportType = "stdio" | HttpMcpTransportType;

interface ResolvedBaseMcpTransportConfig {
  description: string;
  connectionTimeoutMs: number;
}

export type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "stdio";
  transportType: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "http";
  transportType: HttpMcpTransportType;
  url: string;
  headers?: Record<string, string>;
};

export type ResolvedMcpTransportConfig =
  | ResolvedStdioMcpTransportConfig
  | ResolvedHttpMcpTransportConfig;

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

function getConnectionTimeoutMs(rawServer: unknown): number {
  if (
    rawServer &&
    typeof rawServer === "object" &&
    typeof (rawServer as { connectionTimeoutMs?: unknown }).connectionTimeoutMs === "number" &&
    (rawServer as { connectionTimeoutMs: number }).connectionTimeoutMs > 0
  ) {
    return (rawServer as { connectionTimeoutMs: number }).connectionTimeoutMs;
  }
  return DEFAULT_CONNECTION_TIMEOUT_MS;
}

function getRequestedTransport(rawServer: unknown): string {
  if (
    !rawServer ||
    typeof rawServer !== "object" ||
    typeof (rawServer as { transport?: unknown }).transport !== "string"
  ) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty((rawServer as { transport?: string }).transport);
}

function resolveHttpTransportConfig(
  serverName: string,
  rawServer: unknown,
  transportType: HttpMcpTransportType,
): ResolvedHttpMcpTransportConfig | null {
  const launch = resolveHttpMcpServerLaunchConfig(rawServer, {
    onDroppedHeader: (key) => {
      logWarn(
        `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
      );
    },
    onMalformedHeaders: () => {
      logWarn(
        `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
      );
    },
    transportType,
  });
  if (!launch.ok) {
    return null;
  }
  return {
    connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
    description: describeHttpMcpServerLaunchConfig(launch.config),
    headers: launch.config.headers,
    kind: "http",
    transportType: launch.config.transportType,
    url: launch.config.url,
  };
}

export function resolveMcpTransportConfig(
  serverName: string,
  rawServer: unknown,
): ResolvedMcpTransportConfig | null {
  const requestedTransport = getRequestedTransport(rawServer);
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer);
  if (stdioLaunch.ok) {
    return {
      args: stdioLaunch.config.args,
      command: stdioLaunch.config.command,
      connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
      cwd: stdioLaunch.config.cwd,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      env: stdioLaunch.config.env,
      kind: "stdio",
      transportType: "stdio",
    };
  }

  if (
    requestedTransport &&
    requestedTransport !== "sse" &&
    requestedTransport !== "streamable-http"
  ) {
    logWarn(
      `bundle-mcp: skipped server "${serverName}" because transport "${requestedTransport}" is not supported.`,
    );
    return null;
  }

  if (requestedTransport === "streamable-http") {
    const httpTransport = resolveHttpTransportConfig(serverName, rawServer, "streamable-http");
    if (httpTransport) {
      return httpTransport;
    }
  }

  const sseTransport = resolveHttpTransportConfig(serverName, rawServer, "sse");
  if (sseTransport) {
    return sseTransport;
  }

  const httpLaunch = resolveHttpMcpServerLaunchConfig(rawServer);
  const httpReason = httpLaunch.ok ? "not an HTTP MCP server" : httpLaunch.reason;
  logWarn(
    `bundle-mcp: skipped server "${serverName}" because ${stdioLaunch.reason} and ${httpReason}.`,
  );
  return null;
}
