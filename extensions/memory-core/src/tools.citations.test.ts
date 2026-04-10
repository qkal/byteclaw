import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "../../../src/plugins/memory-state.js";
import {
  type MemoryReadParams,
  getMemorySearchManagerMockCalls,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
} from "./memory-tool-manager-mock.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";
import {
  asOpenClawConfig,
  createAutoCitationsMemorySearchTool,
  createDefaultMemoryToolConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

async function waitFor<T>(task: () => Promise<T>, timeoutMs: number = 1500): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for async test condition");
}

beforeEach(() => {
  clearMemoryPluginState();
  resetMemoryToolMockState({
    backend: "builtin",
    readFileImpl: async (params: MemoryReadParams) => ({ path: params.relPath, text: "" }),
    searchImpl: async () => [
      {
        endLine: 7,
        path: "MEMORY.md",
        score: 0.9,
        snippet: "@@ -5,3 @@\nAssistant: noted",
        source: "memory" as const,
        startLine: 5,
      },
    ],
  });
});

describe("memory search citations", () => {
  it("appends source information when citations are enabled", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      agents: { list: [{ default: true, id: "main" }] },
      memory: { citations: "on" },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: { snippet: string; citation?: string }[] };
    expect(details.results[0]?.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(details.results[0]?.citation).toBe("MEMORY.md#L5-L7");
  });

  it("leaves snippet untouched when citations are off", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      agents: { list: [{ default: true, id: "main" }] },
      memory: { citations: "off" },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: { snippet: string; citation?: string }[] };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.results[0]?.citation).toBeUndefined();
  });

  it("clamps decorated snippets to qmd injected budget", async () => {
    setMemoryBackend("qmd");
    const cfg = asOpenClawConfig({
      agents: { list: [{ default: true, id: "main" }] },
      memory: { backend: "qmd", citations: "on", qmd: { limits: { maxInjectedChars: 20 } } },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_qmd", { query: "notes" });
    const details = result.details as { results: { snippet: string; citation?: string }[] };
    expect(details.results[0]?.snippet.length).toBeLessThanOrEqual(20);
  });

  it("honors auto mode for direct chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:dm:u123");
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: { snippet: string }[] };
    expect(details.results[0]?.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:group:c123");
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: { snippet: string }[] };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("does not throw when memory_search fails (e.g. embeddings 429)", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const cfg = createDefaultMemoryToolConfig();
    const tool = createMemorySearchToolOrThrow({ config: cfg });

    const result = await tool.execute("call_1", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      action: "Top up or switch embedding provider, then retry memory_search.",
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
    });
  });

  it("does not throw when memory_get fails", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      throw new Error("path required");
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      disabled: true,
      error: "path required",
      path: "memory/NOPE.md",
      text: "",
    });
  });

  it("returns empty text without error when file does not exist (ENOENT)", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => ({
      path: "memory/2026-02-19.md",
      text: "",
    }));

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      path: "memory/2026-02-19.md",
      text: "",
    });
  });

  it("uses the builtin direct memory file path for memory_get", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_builtin_fast_path", { path: "memory/2026-02-19.md" });

    expect(result.details).toEqual({
      path: "memory/2026-02-19.md",
      text: "",
    });
    expect(getReadAgentMemoryFileMockCalls()).toBe(1);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("persists short-term recall events from memory_search tool hits", async () => {
    const workspaceDir = await createTempWorkspace("memory-tools-recall-");
    try {
      setMemoryBackend("builtin");
      setMemoryWorkspaceDir(workspaceDir);
      setMemorySearchImpl(async () => [
        {
          endLine: 2,
          path: "memory/2026-04-03.md",
          score: 0.95,
          snippet: "Move backups to S3 Glacier.",
          source: "memory" as const,
          startLine: 1,
        },
      ]);

      const tool = createMemorySearchToolOrThrow();
      await tool.execute("call_recall_persist", { query: "glacier backup" });

      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      const storeRaw = await waitFor(async () => await fs.readFile(storePath, "utf8"));
      const store = JSON.parse(storeRaw) as {
        entries?: Record<string, { path: string; recallCount: number }>;
      };
      const entries = Object.values(store.entries ?? {});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        path: "memory/2026-04-03.md",
        recallCount: 1,
      });
    } finally {
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("searches registered wiki corpus supplements without calling memory search", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      get: async () => null,
      search: async () => [
        {
          corpus: "wiki",
          kind: "entity",
          path: "entities/alpha.md",
          score: 4,
          snippet: "Alpha wiki entry",
          title: "Alpha",
        },
      ],
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_wiki_only", { corpus: "wiki", query: "alpha" });

    expect(result.details).toMatchObject({
      results: [
        {
          corpus: "wiki",
          kind: "entity",
          path: "entities/alpha.md",
          score: 4,
          snippet: "Alpha wiki entry",
          title: "Alpha",
        },
      ],
    });
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("merges memory and wiki corpus search results for corpus=all", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      get: async () => null,
      search: async () => [
        {
          corpus: "wiki",
          kind: "entity",
          path: "entities/alpha.md",
          score: 1.1,
          snippet: "Alpha wiki entry",
          title: "Alpha",
        },
      ],
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_corpus", { corpus: "all", query: "alpha" });
    const details = result.details as { results: { corpus: string; path: string }[] };

    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["wiki", "entities/alpha.md"],
      ["memory", "MEMORY.md"],
    ]);
    expect(getMemorySearchManagerMockCalls()).toBe(1);
  });

  it("falls back to a wiki corpus supplement for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("path required");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      get: async () => ({
        content: "Alpha wiki entry",
        corpus: "wiki",
        fromLine: 3,
        kind: "entity",
        lineCount: 5,
        path: "entities/alpha.md",
        title: "Alpha",
      }),
      search: async () => [],
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_fallback", {
      corpus: "all",
      from: 3,
      lines: 5,
      path: "entities/alpha.md",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      fromLine: 3,
      kind: "entity",
      lineCount: 5,
      path: "entities/alpha.md",
      text: "Alpha wiki entry",
      title: "Alpha",
    });
  });
});
