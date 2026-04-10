import { describe, expect, it } from "vitest";
import {
  DEFAULT_MMR_CONFIG,
  type MMRItem,
  applyMMRToHybridResults,
  computeMMRScore,
  jaccardSimilarity,
  mmrRerank,
  textSimilarity,
  tokenize,
} from "./mmr.js";

describe("tokenize", () => {
  it("normalizes, filters, and deduplicates token sets", () => {
    const cases = [
      {
        expected: ["hello", "world", "123"],
        input: "Hello World 123",
        name: "alphanumeric lowercase",
      },
      { expected: [], input: "", name: "empty string" },
      { expected: [], input: "!@#$%^&*()", name: "special chars only" },
      {
        expected: ["hello_world", "test_case"],
        input: "hello_world test_case",
        name: "underscores",
      },
      {
        expected: ["hello", "world"],
        input: "hello hello world world",
        name: "dedupe repeated tokens",
      },
      {
        expected: ["今", "天", "讨", "论", "今天", "天讨", "讨论"],
        input: "今天讨论",
        name: "CJK characters produce unigrams and bigrams",
      },
      {
        expected: ["hello", "test", "你", "好", "世", "界", "你好", "好世", "世界"],
        input: "hello 你好世界 test",
        name: "mixed ASCII and CJK",
      },
      {
        expected: ["龙"],
        input: "龙",
        name: "single CJK character (no bigrams)",
      },
      {
        expected: ["a", "我", "好"],
        input: "我a好",
        name: "non-adjacent CJK chars do not form bigrams",
        // No "我好" bigram — they are separated by "a"
      },
      {
        expected: ["こ", "ん", "に", "ち", "は", "こん", "んに", "にち", "ちは"],
        input: "こんにちは",
        name: "Japanese hiragana",
      },
      {
        expected: ["안", "녕", "하", "세", "요", "안녕", "녕하", "하세", "세요"],
        input: "안녕하세요",
        name: "Korean hangul",
      },
    ] as const;

    for (const testCase of cases) {
      expect(tokenize(testCase.input), testCase.name).toEqual(new Set(testCase.expected));
    }
  });
});

describe("jaccardSimilarity", () => {
  it("computes expected scores for overlap edge cases", () => {
    const cases = [
      {
        expected: 1,
        left: new Set(["a", "b", "c"]),
        name: "identical sets",
        right: new Set(["a", "b", "c"]),
      },
      { expected: 0, left: new Set(["a", "b"]), name: "disjoint sets", right: new Set(["c", "d"]) },
      { expected: 1, left: new Set<string>(), name: "two empty sets", right: new Set<string>() },
      {
        expected: 0,
        left: new Set(["a"]),
        name: "left non-empty right empty",
        right: new Set<string>(),
      },
      {
        expected: 0,
        left: new Set<string>(),
        name: "left empty right non-empty",
        right: new Set(["a"]),
      },
      {
        expected: 0.5,
        left: new Set(["a", "b", "c"]),
        name: "partial overlap",
        right: new Set(["b", "c", "d"]),
      },
    ] as const;

    for (const testCase of cases) {
      expect(jaccardSimilarity(testCase.left, testCase.right), testCase.name).toBe(
        testCase.expected,
      );
    }
  });

  it("is symmetric", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["b", "c"]);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });
});

describe("textSimilarity", () => {
  it("computes expected text-level similarity cases", () => {
    const cases = [
      { expected: 1, left: "hello world", name: "identical", right: "hello world" },
      { expected: 1, left: "hello world", name: "same words reordered", right: "world hello" },
      { expected: 0, left: "hello world", name: "different text", right: "foo bar" },
      { expected: 1, left: "Hello World", name: "case insensitive", right: "hello world" },
      {
        name: "CJK similar texts share tokens",
        left: "今天我们讨论了项目进展",
        right: "今天我们讨论了会议安排",
        // Shared unigrams: 今,天,我,们,讨,论,了 (7) + shared bigrams: 今天,天我,我们,们讨,讨论,论了 (6) = 13 shared
        // Total unique tokens > 13, so similarity > 0 and < 1
        expected: -1, // Placeholder — just check > 0
      },
      {
        expected: 0,
        left: "苹果香蕉",
        name: "CJK completely different texts",
        right: "钢铁煤炭",
      },
    ] as const;

    for (const testCase of cases) {
      if (testCase.expected === -1) {
        // Placeholder: just assert positive similarity
        const sim = textSimilarity(testCase.left, testCase.right);
        expect(sim, testCase.name).toBeGreaterThan(0);
        expect(sim, testCase.name).toBeLessThan(1);
      } else {
        expect(textSimilarity(testCase.left, testCase.right), testCase.name).toBe(
          testCase.expected,
        );
      }
    }
  });
});

describe("computeMMRScore", () => {
  it("balances relevance and diversity across lambda settings", () => {
    const cases = [
      {
        expected: 0.8,
        lambda: 1,
        name: "lambda=1 relevance only",
        relevance: 0.8,
        similarity: 0.5,
      },
      {
        expected: -0.5,
        lambda: 0,
        name: "lambda=0 diversity only",
        relevance: 0.8,
        similarity: 0.5,
      },
      { expected: 0.1, lambda: 0.5, name: "lambda=0.5 mixed", relevance: 0.8, similarity: 0.6 },
      { expected: 0.55, lambda: 0.7, name: "default lambda math", relevance: 1, similarity: 0.5 },
    ] as const;

    for (const testCase of cases) {
      expect(
        computeMMRScore(testCase.relevance, testCase.similarity, testCase.lambda),
        testCase.name,
      ).toBeCloseTo(testCase.expected);
    }
  });
});

describe("empty input behavior", () => {
  it("returns empty array for empty input", () => {
    expect(mmrRerank([])).toEqual([]);
    expect(applyMMRToHybridResults([])).toEqual([]);
  });
});

describe("mmrRerank", () => {
  describe("edge cases", () => {
    it("returns single item unchanged", () => {
      const items: MMRItem[] = [{ content: "hello", id: "1", score: 0.9 }];
      expect(mmrRerank(items)).toEqual(items);
    });

    it("returns copy, not original array", () => {
      const items: MMRItem[] = [{ content: "hello", id: "1", score: 0.9 }];
      const result = mmrRerank(items);
      expect(result).not.toBe(items);
    });

    it("returns items unchanged when disabled", () => {
      const items: MMRItem[] = [
        { content: "hello", id: "1", score: 0.9 },
        { content: "hello", id: "2", score: 0.8 },
      ];
      const result = mmrRerank(items, { enabled: false });
      expect(result).toEqual(items);
    });
  });

  describe("lambda edge cases", () => {
    const diverseItems: MMRItem[] = [
      { content: "apple banana cherry", id: "1", score: 1 },
      { content: "apple banana date", id: "2", score: 0.9 },
      { content: "elderberry fig grape", id: "3", score: 0.8 },
    ];

    it("lambda=1 returns pure relevance order", () => {
      const result = mmrRerank(diverseItems, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("lambda=0 maximizes diversity", () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: 0 });
      // First item is still highest score (no penalty yet)
      expect(result[0].id).toBe("1");
      // Second should be most different from first
      expect(result[1].id).toBe("3"); // Elderberry... is most different
    });

    it("clamps lambda > 1 to 1", () => {
      const result = mmrRerank(diverseItems, { lambda: 1.5 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("clamps lambda < 0 to 0", () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: -0.5 });
      expect(result[0].id).toBe("1");
      expect(result[1].id).toBe("3");
    });
  });

  describe("diversity behavior", () => {
    it("promotes diverse results over similar high-scoring ones", () => {
      const items: MMRItem[] = [
        { content: "machine learning neural networks", id: "1", score: 1 },
        { content: "machine learning deep learning", id: "2", score: 0.95 },
        { content: "database systems sql queries", id: "3", score: 0.9 },
        { content: "machine learning algorithms", id: "4", score: 0.85 },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });

      // First is always highest score
      expect(result[0].id).toBe("1");
      // Second should be the diverse database item, not another ML item
      expect(result[1].id).toBe("3");
    });

    it("handles items with identical content", () => {
      const items: MMRItem[] = [
        { content: "identical content", id: "1", score: 1 },
        { content: "identical content", id: "2", score: 0.9 },
        { content: "different stuff", id: "3", score: 0.8 },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });
      expect(result[0].id).toBe("1");
      // Second should be different, not identical duplicate
      expect(result[1].id).toBe("3");
    });

    it("handles all identical content gracefully", () => {
      const items: MMRItem[] = [
        { content: "same", id: "1", score: 1 },
        { content: "same", id: "2", score: 0.9 },
        { content: "same", id: "3", score: 0.8 },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      // Should still complete without error, order by score as tiebreaker
      expect(result).toHaveLength(3);
    });
  });

  describe("tie-breaking", () => {
    it("uses original score as tiebreaker", () => {
      const items: MMRItem[] = [
        { content: "unique content one", id: "1", score: 1 },
        { content: "unique content two", id: "2", score: 0.9 },
        { content: "unique content three", id: "3", score: 0.8 },
      ];

      // With very different content and lambda=1, should be pure score order
      const result = mmrRerank(items, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("preserves all items even with same MMR scores", () => {
      const items: MMRItem[] = [
        { content: "a", id: "1", score: 0.5 },
        { content: "b", id: "2", score: 0.5 },
        { content: "c", id: "3", score: 0.5 },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(3);
      expect(new Set(result.map((i) => i.id))).toEqual(new Set(["1", "2", "3"]));
    });
  });

  describe("score normalization", () => {
    it("handles items with same scores", () => {
      const items: MMRItem[] = [
        { content: "hello world", id: "1", score: 0.5 },
        { content: "foo bar", id: "2", score: 0.5 },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
    });

    it("handles negative scores", () => {
      const items: MMRItem[] = [
        { content: "hello world", id: "1", score: -0.5 },
        { content: "foo bar", id: "2", score: -1 },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
      // Higher score (less negative) should come first
      expect(result[0].id).toBe("1");
    });
  });
});

describe("applyMMRToHybridResults", () => {
  interface HybridResult {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: string;
  }

  it("preserves all original fields", () => {
    const results: HybridResult[] = [
      {
        endLine: 10,
        path: "/test/file.ts",
        score: 0.9,
        snippet: "hello world",
        source: "memory",
        startLine: 1,
      },
    ];

    const reranked = applyMMRToHybridResults(results);
    expect(reranked[0]).toEqual(results[0]);
  });

  it("creates unique IDs from path and startLine", () => {
    const results: HybridResult[] = [
      {
        endLine: 10,
        path: "/test/a.ts",
        score: 0.9,
        snippet: "same content here",
        source: "memory",
        startLine: 1,
      },
      {
        endLine: 30,
        path: "/test/a.ts",
        score: 0.8,
        snippet: "same content here",
        source: "memory",
        startLine: 20,
      },
    ];

    // Should work without ID collision
    const reranked = applyMMRToHybridResults(results);
    expect(reranked).toHaveLength(2);
  });

  it("re-ranks results for diversity", () => {
    const results: HybridResult[] = [
      {
        endLine: 10,
        path: "/a.ts",
        score: 1,
        snippet: "function add numbers together",
        source: "memory",
        startLine: 1,
      },
      {
        endLine: 10,
        path: "/b.ts",
        score: 0.95,
        snippet: "function add values together",
        source: "memory",
        startLine: 1,
      },
      {
        endLine: 10,
        path: "/c.ts",
        score: 0.9,
        snippet: "database connection pool",
        source: "memory",
        startLine: 1,
      },
    ];

    const reranked = applyMMRToHybridResults(results, { enabled: true, lambda: 0.5 });

    // First stays the same (highest score)
    expect(reranked[0].path).toBe("/a.ts");
    // Second should be the diverse one
    expect(reranked[1].path).toBe("/c.ts");
  });

  it("respects disabled config", () => {
    const results: HybridResult[] = [
      { endLine: 10, path: "/a.ts", score: 0.9, snippet: "test", source: "memory", startLine: 1 },
      { endLine: 10, path: "/b.ts", score: 0.8, snippet: "test", source: "memory", startLine: 1 },
    ];

    const reranked = applyMMRToHybridResults(results, { enabled: false });
    expect(reranked).toEqual(results);
  });
});

describe("DEFAULT_MMR_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_MMR_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MMR_CONFIG.lambda).toBe(0.7);
  });
});
