import { describe, expect, it } from "vitest";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

describe("resolveMcpTransportConfig", () => {
  it("resolves stdio config with connection timeout", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      args: ["./server.mjs"],
      command: "node",
      connectionTimeoutMs: 12_345,
    });

    expect(resolved).toMatchObject({
      args: ["./server.mjs"],
      command: "node",
      connectionTimeoutMs: 12_345,
      kind: "stdio",
      transportType: "stdio",
    });
  });

  it("resolves SSE config by default", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      headers: {
        Authorization: "Bearer token",
        "X-Count": 42,
      },
      url: "https://mcp.example.com/sse",
    });

    expect(resolved).toEqual({
      connectionTimeoutMs: 30_000,
      description: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token",
        "X-Count": "42",
      },
      kind: "http",
      transportType: "sse",
      url: "https://mcp.example.com/sse",
    });
  });

  it("resolves explicit streamable HTTP config", () => {
    const resolved = resolveMcpTransportConfig("probe", {
      transport: "streamable-http",
      url: "https://mcp.example.com/http",
    });

    expect(resolved).toMatchObject({
      kind: "http",
      transportType: "streamable-http",
      url: "https://mcp.example.com/http",
    });
  });
});
