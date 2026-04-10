import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn(() => ({
    agentId: "main",
    tools: [
      {
        description: "send a message",
        execute: async () => ({
          content: [{ text: "ok", type: "text" }],
        }),
        name: "message",
        parameters: { properties: {}, type: "object" },
      },
    ],
  })),
);

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ session: { mainKey: "main" } }),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  startMcpLoopbackServer,
} from "./mcp-http.js";

let server: Awaited<ReturnType<typeof startMcpLoopbackServer>> | undefined;

async function sendRaw(params: {
  port: number;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/mcp`, {
    body: params.body,
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...params.headers,
    },
    method: "POST",
  });
}

beforeEach(() => {
  resolveGatewayScopedToolsMock.mockClear();
  resolveGatewayScopedToolsMock.mockReturnValue({
    agentId: "main",
    tools: [
      {
        description: "send a message",
        execute: async () => ({
          content: [{ text: "ok", type: "text" }],
        }),
        name: "message",
        parameters: { properties: {}, type: "object" },
      },
    ],
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("mcp loopback server", () => {
  it("passes session, account, and message channel headers into shared tool resolution", async () => {
    const port = await getFreePortBlockWithPermissionFallback({
      fallbackBase: 53_000,
      offsets: [0],
    });
    server = await startMcpLoopbackServer(port);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        "content-type": "application/json",
        "x-openclaw-account-id": "work",
        "x-openclaw-message-channel": "telegram",
        "x-session-key": "agent:main:telegram:group:chat123",
      },
      port: server.port,
      token: runtime?.token,
    });

    expect(response.status).toBe(200);
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        messageProvider: "telegram",
        sessionKey: "agent:main:telegram:group:chat123",
        surface: "loopback",
      }),
    );
  });

  it("tracks the active runtime only while the server is running", async () => {
    server = await startMcpLoopbackServer(0);
    const active = getActiveMcpLoopbackRuntime();
    expect(active?.port).toBe(server.port);
    expect(active?.token).toMatch(/^[0-9a-f]{64}$/);

    await server.close();
    server = undefined;
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  });

  it("returns 401 when the bearer token is missing", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: { "content-type": "application/json" },
      port: server.port,
    });
    expect(response.status).toBe(401);
  });

  it("returns 415 when the content type is not JSON", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      body: "{}",
      headers: { "content-type": "text/plain" },
      port: server.port,
      token: runtime?.token,
    });
    expect(response.status).toBe(415);
  });
});

describe("createMcpLoopbackServerConfig", () => {
  it("builds a server entry with env-driven headers", () => {
    const config = createMcpLoopbackServerConfig(23_119) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(config.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(config.mcpServers?.openclaw?.headers?.Authorization).toBe(
      "Bearer ${OPENCLAW_MCP_TOKEN}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-message-channel"]).toBe(
      "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
    );
  });
});
