import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool, createSandboxedReadTool } from "./pi-tools.read.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) {
    return "";
  }
  const textBlock = content.find(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  ) as { text?: string } | undefined;
  return textBlock?.text ?? "";
}

describe("createOpenClawCodingTools read behavior", () => {
  it("applies sandbox path guards to canonical path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "openclaw-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const readTool = createSandboxedReadTool({
        bridge: createHostSandboxFsBridge(tmpDir),
        root: tmpDir,
      });
      await expect(readTool.execute("sandbox-1", { path: outsidePath })).rejects.toThrow(
        /sandbox root/i,
      );
    } finally {
      await fs.rm(outsidePath, { force: true });
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("auto-pages read output across chunks when context window budget allows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-autopage-"));
    const filePath = path.join(tmpDir, "big.txt");
    const lines = Array.from(
      { length: 5000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        bridge: createHostSandboxFsBridge(tmpDir),
        modelContextWindowTokens: 200_000,
        root: tmpDir,
      });
      const result = await readTool.execute("read-autopage-1", { path: "big.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("line-5000");
      expect(text).not.toContain("Read output capped at");
      expect(text).not.toMatch(/Use offset=\d+ to continue\.\]$/);
    } finally {
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("adds capped continuation guidance when aggregated read output reaches budget", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-cap-"));
    const filePath = path.join(tmpDir, "huge.txt");
    const lines = Array.from(
      { length: 8000 },
      (_unused, i) => `line-${String(i + 1).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
    );
    await fs.writeFile(filePath, lines.join("\n"), "utf8");
    try {
      const readTool = createSandboxedReadTool({
        bridge: createHostSandboxFsBridge(tmpDir),
        root: tmpDir,
      });
      const result = await readTool.execute("read-cap-1", { path: "huge.txt" });
      const text = extractToolText(result);
      expect(text).toContain("line-0001");
      expect(text).toContain("[Read output capped at 50KB for this call. Use offset=");
      expect(text).not.toContain("line-8000");
    } finally {
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("strips truncation.content details from read results while preserving other fields", async () => {
    const readResult: AgentToolResult<unknown> = {
      content: [{ text: "line-0001", type: "text" as const }],
      details: {
        truncation: {
          content: "hidden duplicate payload",
          firstLineExceedsLimit: false,
          outputLines: 1,
          truncated: true,
        },
      },
    };
    const baseRead: AgentTool = {
      description: "test read",
      execute: vi.fn(async () => readResult),
      label: "read",
      name: "read",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
        path: Type.String(),
      }),
    };

    const wrapped = createOpenClawReadTool(
      baseRead as unknown as Parameters<typeof createOpenClawReadTool>[0],
    );
    const result = await wrapped.execute("read-strip-1", { limit: 1, path: "demo.txt" });

    const { details } = result as { details?: { truncation?: Record<string, unknown> } };
    expect(details?.truncation).toMatchObject({
      firstLineExceedsLimit: false,
      outputLines: 1,
      truncated: true,
    });
    expect(details?.truncation).not.toHaveProperty("content");
  });
});
