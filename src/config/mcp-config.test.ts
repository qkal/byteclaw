import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "./mcp-config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config mcp config", () => {
  it("writes and removes top-level mcp servers", async () => {
    await withTempHomeConfig({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "context7",
        server: {
          args: ["context7-mcp"],
          command: "uvx",
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.context7).toEqual({
        args: ["context7-mcp"],
        command: "uvx",
      });

      const unsetResult = await unsetConfiguredMcpServer({ name: "context7" });
      expect(unsetResult.ok).toBe(true);

      const reloaded = await listConfiguredMcpServers();
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) {
        throw new Error("expected MCP config to reload");
      }
      expect(reloaded.mcpServers).toEqual({});
    });
  });

  it("fails closed when the config file is invalid", async () => {
    await withTempHomeConfig({}, async ({ configPath }) => {
      await fs.writeFile(configPath, "{", "utf8");

      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("expected invalid config to fail");
      }
      expect(loaded.path).toBe(configPath);
    });
  });

  it("accepts SSE MCP configs with headers at the config layer", async () => {
    await withTempHomeConfig({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: {
          headers: {
            Authorization: "Bearer token123",
            "X-Debug": true,
            "X-Retry": 1,
          },
          url: "https://example.com/mcp",
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.remote).toEqual({
        headers: {
          Authorization: "Bearer token123",
          "X-Debug": true,
          "X-Retry": 1,
        },
        url: "https://example.com/mcp",
      });
    });
  });
});
