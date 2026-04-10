import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword } from "./manager-search.js";

describe("searchKeyword trigram fallback", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function createTrigramDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      cacheEnabled: false,
      db,
      embeddingCacheTable: "embedding_cache",
      ftsEnabled: true,
      ftsTable: "chunks_fts",
      ftsTokenizer: "trigram",
    });
    return db;
  }

  async function runSearch(params: {
    rows: { id: string; path: string; text: string }[];
    query: string;
  }) {
    const db = createTrigramDb();
    try {
      const insert = db.prepare(
        "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of params.rows) {
        insert.run(row.text, row.id, row.path, "memory", "mock-embed", 1, 1);
      }
      return await searchKeyword({
        bm25RankToScore,
        buildFtsQuery,
        db,
        ftsTable: "chunks_fts",
        ftsTokenizer: "trigram",
        limit: 10,
        providerModel: "mock-embed",
        query: params.query,
        snippetMaxChars: 200,
        sourceFilter: { params: [], sql: "" },
      });
    } finally {
      db.close();
    }
  }

  it("finds short Chinese queries with substring fallback", async () => {
    const results = await runSearch({
      query: "成语",
      rows: [{ id: "1", path: "memory/zh.md", text: "今天玩成语接龙游戏" }],
    });
    expect(results.map((row) => row.id)).toContain("1");
    expect(results[0]?.textScore).toBe(1);
  });

  it("finds short Japanese and Korean queries with substring fallback", async () => {
    const japaneseResults = await runSearch({
      query: "しり とり",
      rows: [{ id: "jp", path: "memory/jp.md", text: "今日はしりとり大会" }],
    });
    expect(japaneseResults.map((row) => row.id)).toEqual(["jp"]);

    const koreanResults = await runSearch({
      query: "끝말",
      rows: [{ id: "ko", path: "memory/ko.md", text: "오늘 끝말잇기 게임을 했다" }],
    });
    expect(koreanResults.map((row) => row.id)).toEqual(["ko"]);
  });

  it("keeps MATCH semantics for long trigram terms while requiring short CJK substrings", async () => {
    const results = await runSearch({
      query: "成语接龙 游戏",
      rows: [
        { id: "match", path: "memory/good.md", text: "今天玩成语接龙游戏" },
        { id: "partial", path: "memory/partial.md", text: "今天玩成语接龙" },
      ],
    });
    expect(results.map((row) => row.id)).toEqual(["match"]);
    expect(results[0]?.textScore).toBeGreaterThan(0);
  });
});
