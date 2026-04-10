import { describe, expect, it } from "vitest";
import {
  cachedJsonParse,
  clearJsonParseCache,
  getJsonParseCacheStats,
  optimizedJsonParse,
  optimizedJsonStringify,
} from "./json-optimizer.js";

describe("json-optimizer", () => {
  describe("cachedJsonParse", () => {
    it("caches parsed JSON", () => {
      const text = '{"key":"value"}';
      const result1 = cachedJsonParse(text);
      const result2 = cachedJsonParse(text);
      expect(result1).toEqual(result2);
      const stats = getJsonParseCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    });

    it("clears cache", () => {
      cachedJsonParse('{"key":"value"}');
      clearJsonParseCache();
      const stats = getJsonParseCacheStats();
      expect(stats.size).toBe(0);
    });

    it("provides cache statistics", () => {
      const stats = getJsonParseCacheStats();
      expect(stats).toHaveProperty("size");
      expect(stats).toHaveProperty("maxSize");
    });
  });

  describe("optimizedJsonStringify", () => {
    it("stringifies plain objects", () => {
      const result = optimizedJsonStringify({ key: "value" });
      expect(result).toBe('{"key":"value"}');
    });

    it("handles bigint", () => {
      const result = optimizedJsonStringify({ big: 123n });
      expect(result).toBe('{"big":"123"}');
    });

    it("handles functions", () => {
      const result = optimizedJsonStringify({ fn: () => {} });
      expect(result).toBe('{"fn":"[Function]"}');
    });

    it("handles errors", () => {
      const error = new Error("test");
      const result = optimizedJsonStringify({ error });
      expect(result).toContain("test");
    });

    it("handles Uint8Array", () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = optimizedJsonStringify({ arr });
      expect(result).toContain("Uint8Array");
    });

    it("handles errors gracefully", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = optimizedJsonStringify(circular);
      expect(result).toBeNull();
    });
  });

  describe("optimizedJsonParse", () => {
    it("parses plain JSON", () => {
      const result = optimizedJsonParse('{"key":"value"}');
      expect(result).toEqual({ key: "value" });
    });
  });
});
