import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createPluginToolsMcpServer } from "./plugin-tools-serve.js";

async function connectPluginToolsServer(tools: AnyAgentTool[]) {
  const server = createPluginToolsMcpServer({ tools });
  const client = new Client({ name: "plugin-tools-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin tools MCP server", () => {
  it("lists registered plugin tools with their input schema", async () => {
    const tool = {
      description: "Recall stored memory",
      execute: vi.fn(),
      name: "memory_recall",
      parameters: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([tool]);
    try {
      const listed = await session.client.listTools();
      expect(listed.tools).toEqual([
        expect.objectContaining({
          description: "Recall stored memory",
          inputSchema: expect.objectContaining({
            required: ["query"],
            type: "object",
          }),
          name: "memory_recall",
        }),
      ]);
    } finally {
      await session.close();
    }
  });

  it("serializes non-array tool content as text for MCP callers", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: "Stored.",
    });
    const tool = {
      description: "Store memory",
      execute,
      name: "memory_store",
      parameters: { properties: {}, type: "object" },
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([tool]);
    try {
      const result = await session.client.callTool({
        arguments: { text: "remember this" },
        name: "memory_store",
      });
      expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^mcp-\d+$/), {
        text: "remember this",
      });
      expect(result.content).toEqual([{ text: "Stored.", type: "text" }]);
    } finally {
      await session.close();
    }
  });

  it("returns MCP errors for unknown tools and thrown tool errors", async () => {
    const failingTool = {
      description: "Forget memory",
      execute: vi.fn().mockRejectedValue(new Error("boom")),
      name: "memory_forget",
      parameters: { properties: {}, type: "object" },
    } as unknown as AnyAgentTool;

    const session = await connectPluginToolsServer([failingTool]);
    try {
      const unknown = await session.client.callTool({
        arguments: {},
        name: "missing_tool",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toEqual([{ text: "Unknown tool: missing_tool", type: "text" }]);

      const failed = await session.client.callTool({
        arguments: {},
        name: "memory_forget",
      });
      expect(failed.isError).toBe(true);
      expect(failed.content).toEqual([{ text: "Tool error: boom", type: "text" }]);
    } finally {
      await session.close();
    }
  });
});
