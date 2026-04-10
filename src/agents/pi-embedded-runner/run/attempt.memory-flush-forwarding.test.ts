import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../pi-tools.types.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";

const MEMORY_RELATIVE_PATH = "memory/2026-03-24.md";

function createAttemptParams(workspaceDir: string) {
  return {
    authStorage: {} as AuthStorage,
    memoryFlushWritePath: MEMORY_RELATIVE_PATH,
    model: {
      api: "responses",
      contextWindow: 128_000,
      id: "gpt-5.4",
      input: ["text"],
      provider: "openai",
    } as Model<Api>,
    modelId: "gpt-5.4",
    modelRegistry: {} as ModelRegistry,
    prompt: "flush durable notes",
    provider: "openai",
    runId: "run-memory-flush",
    sessionFile: path.join(workspaceDir, "session.json"),
    sessionId: "session-memory-flush",
    sessionKey: "agent:main",
    thinkLevel: "off" as const,
    timeoutMs: 30_000,
    trigger: "memory" as const,
    workspaceDir,
  };
}

describe("runEmbeddedAttempt memory flush tool forwarding", () => {
  it("forwards memory trigger metadata into tool creation so append-only guards activate", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-memory-flush-"));

    try {
      expect(buildEmbeddedAttemptToolRunContext(createAttemptParams(workspaceDir))).toMatchObject({
        memoryFlushWritePath: MEMORY_RELATIVE_PATH,
        trigger: "memory",
      });
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("activates the memory flush append-only write wrapper", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-memory-flush-"));
    const memoryFile = path.join(workspaceDir, MEMORY_RELATIVE_PATH);

    try {
      await fs.mkdir(path.dirname(memoryFile), { recursive: true });
      await fs.writeFile(memoryFile, "seed", "utf8");

      const { wrapToolMemoryFlushAppendOnlyWrite } = await import("../../pi-tools.read.js");
      const fallbackWrite = vi.fn(async () => {
        throw new Error("append-only wrapper should not delegate to the base write tool");
      });
      const writeTool: AnyAgentTool = {
        description: "Write content to a file.",
        execute: fallbackWrite,
        label: "write",
        name: "write",
        parameters: { properties: {}, type: "object" },
      };
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
        relativePath: MEMORY_RELATIVE_PATH,
        root: workspaceDir,
      });

      await expect(
        wrapped.execute("call-memory-flush-append", {
          content: "new durable note",
          path: MEMORY_RELATIVE_PATH,
        }),
      ).resolves.toMatchObject({
        content: [{ text: `Appended content to ${MEMORY_RELATIVE_PATH}.`, type: "text" }],
        details: {
          appendOnly: true,
          path: MEMORY_RELATIVE_PATH,
        },
      });
      await expect(fs.readFile(memoryFile, "utf8")).resolves.toBe("seed\nnew durable note");
      await expect(
        wrapped.execute("call-memory-flush-deny", {
          content: "wrong target",
          path: "memory/other-day.md",
        }),
      ).rejects.toThrow(
        `Memory flush writes are restricted to ${MEMORY_RELATIVE_PATH}; use that path only.`,
      );
      expect(fallbackWrite).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });
});
