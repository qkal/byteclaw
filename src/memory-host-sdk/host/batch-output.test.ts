import { describe, expect, it } from "vitest";
import { applyEmbeddingBatchOutputLine } from "./batch-output.js";

describe("applyEmbeddingBatchOutputLine", () => {
  it("stores embedding for successful response", () => {
    const remaining = new Set(["req-1"]);
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();

    applyEmbeddingBatchOutputLine({
      byCustomId,
      errors,
      line: {
        custom_id: "req-1",
        response: {
          body: { data: [{ embedding: [0.1, 0.2] }] },
          status_code: 200,
        },
      },
      remaining,
    });

    expect(remaining.has("req-1")).toBe(false);
    expect(errors).toEqual([]);
    expect(byCustomId.get("req-1")).toEqual([0.1, 0.2]);
  });

  it("records provider error from line.error", () => {
    const remaining = new Set(["req-2"]);
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();

    applyEmbeddingBatchOutputLine({
      byCustomId,
      errors,
      line: {
        custom_id: "req-2",
        error: { message: "provider failed" },
      },
      remaining,
    });

    expect(remaining.has("req-2")).toBe(false);
    expect(errors).toEqual(["req-2: provider failed"]);
    expect(byCustomId.size).toBe(0);
  });

  it("records non-2xx response errors and empty embedding errors", () => {
    const remaining = new Set(["req-3", "req-4"]);
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();

    applyEmbeddingBatchOutputLine({
      byCustomId,
      errors,
      line: {
        custom_id: "req-3",
        response: {
          body: { error: { message: "internal" } },
          status_code: 500,
        },
      },
      remaining,
    });

    applyEmbeddingBatchOutputLine({
      byCustomId,
      errors,
      line: {
        custom_id: "req-4",
        response: {
          body: { data: [] },
          status_code: 200,
        },
      },
      remaining,
    });

    expect(errors).toEqual(["req-3: internal", "req-4: empty embedding"]);
    expect(byCustomId.size).toBe(0);
  });
});
