import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryEmbeddingProviders as clearRegistry,
  registerMemoryEmbeddingProvider as registerAdapter,
} from "../../../../src/plugins/memory-embedding-providers.js";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

let embedBatchCalls = 0;
let embedBatchInputCalls = 0;
let providerCalls: { provider?: string; model?: string; outputDimensionality?: number }[] = [];
let forceNoProvider = false;

vi.mock("./embeddings.js", () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    const image = lower.split("image").length - 1;
    const audio = lower.split("audio").length - 1;
    return [alpha, beta, image, audio];
  };
  return {
    createEmbeddingProvider: async (options: {
      provider?: string;
      model?: string;
      outputDimensionality?: number;
    }) => {
      providerCalls.push({
        model: options.model,
        outputDimensionality: options.outputDimensionality,
        provider: options.provider,
      });
      if (forceNoProvider) {
        return {
          provider: null,
          providerUnavailableReason: "No API key found for provider",
          requestedProvider: options.provider ?? "auto",
        };
      }
      const providerId = options.provider === "gemini" ? "gemini" : "mock";
      const model = options.model ?? "mock-embed";
      return {
        provider: {
          embedBatch: async (texts: string[]) => {
            embedBatchCalls += 1;
            return texts.map(embedText);
          },
          embedQuery: async (text: string) => embedText(text),
          id: providerId,
          model,
          ...(providerId === "gemini"
            ? {
                embedBatchInputs: async (
                  inputs: {
                    text: string;
                    parts?: Array<
                      | { type: "text"; text: string }
                      | { type: "inline-data"; mimeType: string; data: string }
                    >;
                  }[],
                ) => {
                  embedBatchInputCalls += 1;
                  return inputs.map((input) => {
                    const inlineData = input.parts?.find((part) => part.type === "inline-data");
                    if (inlineData?.type === "inline-data" && inlineData.data.length > 9000) {
                      throw new Error("payload too large");
                    }
                    const mimeType =
                      inlineData?.type === "inline-data" ? inlineData.mimeType : undefined;
                    if (mimeType?.startsWith("image/")) {
                      return [0, 0, 1, 0];
                    }
                    if (mimeType?.startsWith("audio/")) {
                      return [0, 0, 0, 1];
                    }
                    return embedText(input.text);
                  });
                },
              }
            : {}),
        },
        requestedProvider: options.provider ?? "openai",
        ...(providerId === "gemini"
          ? {
              runtime: {
                cacheKeyData: {
                  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                  headers: [],
                  model,
                  outputDimensionality: options.outputDimensionality,
                  provider: "gemini",
                },
                id: "gemini",
              },
            }
          : {}),
      };
    },
  };
});

describe("memory index", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let indexVectorPath = "";
  let indexMainPath = "";
  let indexMultimodalPath = "";

  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexMainPath = path.join(workspaceDir, "index-main.sqlite");
    indexVectorPath = path.join(workspaceDir, "index-vector.sqlite");
    indexMultimodalPath = path.join(workspaceDir, "index-multimodal.sqlite");
  });

  afterAll(async () => {
    await Promise.all([...managersForCleanup].map((manager) => manager.close()));
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  });

  afterEach(async () => {
    await closeAllMemorySearchManagers();
    clearRegistry();
    managersForCleanup.clear();
  });

  beforeEach(async () => {
    // Perf: most suites don't need atomic swap behavior for full reindexes.
    // Keep atomic reindex tests on the safe path.
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    clearRegistry();
    registerBuiltInMemoryEmbeddingProviders({ registerMemoryEmbeddingProvider: registerAdapter });
    embedBatchCalls = 0;
    embedBatchInputCalls = 0;
    providerCalls = [];
    forceNoProvider = false;

    rmSync(workspaceDir, { force: true, recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  function resetManagerForTest(manager: MemoryIndexManager) {
    // These tests reuse managers for performance. Clear the index + embedding
    // Cache to keep each test fully isolated.
    const { db } = manager as unknown as {
      db: {
        exec: (sql: string) => void;
        prepare: (sql: string) => { get: (name: string) => { name?: string } | undefined };
      };
    };
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    const embeddingCacheTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("embedding_cache");
    if (embeddingCacheTable?.name === "embedding_cache") {
      db.exec("DELETE FROM embedding_cache");
    }
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = false;
  }

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  function createCfg(params: {
    storePath: string;
    extraPaths?: string[];
    sources?: ("memory" | "sessions")[];
    sessionMemory?: boolean;
    provider?: "openai" | "gemini";
    model?: string;
    outputDimensionality?: number;
    multimodal?: {
      enabled?: boolean;
      modalities?: ("image" | "audio" | "all")[];
      maxFileBytes?: number;
    };
    vectorEnabled?: boolean;
    cacheEnabled?: boolean;
    minScore?: number;
    onSearch?: boolean;
    hybrid?: { enabled: boolean; vectorWeight?: number; textWeight?: number };
  }): TestCfg {
    return {
      agents: {
        defaults: {
          memorySearch: {
            provider: params.provider ?? "openai",
            model: params.model ?? "mock-embed",
            outputDimensionality: params.outputDimensionality,
            store: { path: params.storePath, vector: { enabled: params.vectorEnabled ?? false } },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { overlap: 0, tokens: 4000 },
            sync: { onSearch: params.onSearch ?? true, onSessionStart: false, watch: false },
            query: {
              hybrid: params.hybrid ?? { enabled: false },
              minScore: params.minScore ?? 0,
            },
            cache: params.cacheEnabled ? { enabled: true } : undefined,
            extraPaths: params.extraPaths,
            multimodal: params.multimodal,
            sources: params.sources,
            experimental: { sessionMemory: params.sessionMemory ?? false },
          },
          workspace: workspaceDir,
        },
        list: [{ default: true, id: "main" }],
      },
    };
  }

  function requireManager(
    result: Awaited<ReturnType<typeof getMemorySearchManager>>,
    missingMessage = "manager missing",
  ): MemoryIndexManager {
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error(missingMessage);
    }
    return result.manager as MemoryIndexManager;
  }

  async function getPersistentManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ agentId: "main", cfg });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager;
  }

  async function getFreshManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const { getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js");
    return await getRequiredMemoryIndexManager({ agentId: "main", cfg });
  }

  async function expectHybridKeywordSearchFindsMemory(cfg: TestCfg) {
    const manager = await getFreshManager(cfg);
    try {
      const status = manager.status();
      if (!status.fts?.available) {
        return;
      }

      await manager.sync({ reason: "test" });
      const results = await manager.search("zebra");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
    } finally {
      await manager.close?.();
    }
  }

  it.skip("indexes memory files and searches", async () => {
    const cfg = createCfg({
      hybrid: { enabled: true, textWeight: 0.5, vectorWeight: 0.5 },
      storePath: indexMainPath,
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });
      const results = await manager.search("alpha");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
      const status = manager.status();
      expect(status.sourceCounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            chunks: status.chunks,
            files: status.files,
            source: "memory",
          }),
        ]),
      );
    } finally {
      await manager.close?.();
    }
  });

  it("indexes multimodal image and audio files from extra paths with Gemini structured inputs", async () => {
    const mediaDir = path.join(workspaceDir, "media-memory");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(mediaDir, "meeting.wav"), Buffer.from("wav"));

    const cfg = createCfg({
      extraPaths: [mediaDir],
      model: "gemini-embedding-2-preview",
      multimodal: { enabled: true, modalities: ["image", "audio"] },
      provider: "gemini",
      storePath: indexMultimodalPath,
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);

    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    const audioResults = await manager.search("audio");
    expect(audioResults.some((result) => result.path.endsWith("meeting.wav"))).toBe(true);
  });

  it.skip("finds keyword matches via hybrid search when query embedding is zero", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        hybrid: { enabled: true, textWeight: 1, vectorWeight: 0 },
        storePath: indexMainPath,
      }),
    );
  });

  it.skip("preserves keyword-only hybrid hits when minScore exceeds text weight", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        hybrid: { enabled: true, textWeight: 0.3, vectorWeight: 0.7 },
        minScore: 0.35,
        storePath: indexMainPath,
      }),
    );
  });

  it("reports vector availability after probe", async () => {
    const cfg = createCfg({ storePath: indexVectorPath, vectorEnabled: true });
    const manager = await getPersistentManager(cfg);
    const available = await manager.probeVectorAvailability();
    const status = manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("builds FTS index and returns search results when no embedding provider is available", async () => {
    forceNoProvider = true;

    const cfg = createCfg({
      hybrid: { enabled: true },
      minScore: 0.35,
      storePath: path.join(workspaceDir, "index-fts-only.sqlite"),
    });
    const result = await getMemorySearchManager({ agentId: "main", cfg });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);

    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.chunks).toBeGreaterThan(0);
    expect(embedBatchCalls).toBe(0);

    const results = await manager.search("Alpha");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toMatch(/Alpha/i);

    const noResults = await manager.search("nonexistent_xyz_keyword");
    expect(noResults.length).toBe(0);
  });

  it("prefers exact session transcript hits in FTS-only mode", async () => {
    forceNoProvider = true;
    const stateDir = path.join(workspaceDir, ".state-session-ranking");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const cfg = createCfg({
        hybrid: { enabled: true, textWeight: 0.3, vectorWeight: 0.7 },
        minScore: 0,
        sessionMemory: true,
        sources: ["memory", "sessions"],
        storePath: path.join(workspaceDir, "index-fts-session-ranking.sqlite"),
      });
      const result = await getMemorySearchManager({ agentId: "main", cfg });
      const manager = requireManager(result);
      managersForCleanup.add(manager);
      resetManagerForTest(manager);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      await fs.writeFile(memoryPath, "Project Nebula stale codename: ORBIT-9.\n", "utf8");
      const staleAt = new Date("2020-01-01T00:00:00.000Z");
      await fs.utimes(memoryPath, staleAt, staleAt);

      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "session-ranking.jsonl");
      const now = Date.parse("2026-04-07T15:25:04.113Z");
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            id: "session-ranking",
            timestamp: new Date(now - 60_000).toISOString(),
            type: "session",
          }),
          JSON.stringify({
            message: {
              content: [{ text: "What is the current Project Nebula codename?", type: "text" }],
              role: "user",
              timestamp: new Date(now - 30_000).toISOString(),
            },
            type: "message",
          }),
          JSON.stringify({
            message: {
              content: [{ text: "The current Project Nebula codename is ORBIT-10.", type: "text" }],
              role: "assistant",
              timestamp: new Date(now).toISOString(),
            },
            type: "message",
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      await manager.sync({ force: true, reason: "test" });
      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        maxResults: 3,
        minScore: 0,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bootstraps an empty index on first search so session transcript hits are available", async () => {
    forceNoProvider = true;
    const stateDir = path.join(workspaceDir, ".state-session-bootstrap");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const cfg = createCfg({
        hybrid: { enabled: true, textWeight: 0.3, vectorWeight: 0.7 },
        minScore: 0,
        sessionMemory: true,
        sources: ["memory", "sessions"],
        storePath: path.join(workspaceDir, "index-fts-session-bootstrap.sqlite"),
      });
      const result = await getMemorySearchManager({ agentId: "main", cfg });
      const manager = requireManager(result);
      managersForCleanup.add(manager);
      resetManagerForTest(manager);

      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "session-bootstrap.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            id: "session-bootstrap",
            timestamp: "2026-04-07T15:24:04.113Z",
            type: "session",
          }),
          JSON.stringify({
            message: {
              content: [{ text: "The current Project Nebula codename is ORBIT-10.", type: "text" }],
              role: "assistant",
              timestamp: "2026-04-07T15:25:04.113Z",
            },
            type: "message",
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const results = await manager.search("current Project Nebula codename ORBIT-10", {
        maxResults: 3,
        minScore: 0,
      });

      expect(results[0]?.source).toBe("sessions");
      expect(results[0]?.snippet).toContain("ORBIT-10");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
