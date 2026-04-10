import { describe, expect, it } from "vitest";
import {
  TOOL_NAME_SEPARATOR,
  buildSafeToolName,
  normalizeReservedToolNames,
  sanitizeServerName,
} from "./pi-bundle-mcp-names.js";

describe("pi bundle MCP names", () => {
  it("sanitizes and disambiguates server names", () => {
    const usedNames = new Set<string>();

    expect(sanitizeServerName("vigil-harbor", usedNames)).toBe("vigil-harbor");
    expect(sanitizeServerName("vigil:harbor", usedNames)).toBe("vigil-harbor-2");
  });

  it("builds provider-safe tool names and avoids collisions", () => {
    const reservedNames = normalizeReservedToolNames(["memory__status"]);

    const safeToolName = buildSafeToolName({
      reservedNames,
      serverName: "memory",
      toolName: "status",
    });
    expect(safeToolName).toBe(`memory${TOOL_NAME_SEPARATOR}status-2`);
  });

  it("truncates overlong tool names while keeping the server prefix", () => {
    const safeToolName = buildSafeToolName({
      reservedNames: new Set(),
      serverName: "memory",
      toolName: "x".repeat(200),
    });

    expect(safeToolName.startsWith(`memory${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(safeToolName.length).toBeLessThanOrEqual(64);
  });
});
