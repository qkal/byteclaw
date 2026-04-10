import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  collectMemoryCachedEmbeddings,
  loadMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

describe("memory embedding cache", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function createDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      cacheEnabled: true,
      db,
      embeddingCacheTable: "embedding_cache",
      ftsEnabled: false,
      ftsTable: "chunks_fts",
      ftsTokenizer: "unicode61",
    });
    return db;
  }

  it("loads cached embeddings for the active provider key", () => {
    const db = createDb();
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        entries: [
          { embedding: [0.1, 0.2], hash: "a" },
          { embedding: [0.3, 0.4], hash: "b" },
        ],
        now: 123,
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
      });

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        hashes: ["a", "b", "a"],
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
      });

      expect(cached).toEqual(
        new Map([
          ["a", [0.1, 0.2]],
          ["b", [0.3, 0.4]],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("reuses cached embeddings on forced reindex instead of scheduling new embeds", () => {
    const cached = new Map<string, number[]>([
      ["alpha", [0.1, 0.2]],
      ["beta", [0.3, 0.4]],
    ]);
    const embedMissing = vi.fn();

    const plan = collectMemoryCachedEmbeddings({
      cached,
      chunks: [{ hash: "alpha" }, { hash: "beta" }],
    });

    if (plan.missing.length > 0) {
      embedMissing(plan.missing);
    }

    expect(plan.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(plan.missing).toHaveLength(0);
    expect(embedMissing).not.toHaveBeenCalled();
  });
});
