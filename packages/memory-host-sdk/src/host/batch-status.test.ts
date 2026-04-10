import { describe, expect, it } from "vitest";
import {
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  throwIfBatchTerminalFailure,
} from "./batch-status.js";

describe("batch-status helpers", () => {
  it("resolves completion payload from completed status", () => {
    expect(
      resolveBatchCompletionFromStatus({
        batchId: "b1",
        provider: "openai",
        status: {
          error_file_id: "err-1",
          output_file_id: "out-1",
        },
      }),
    ).toEqual({
      errorFileId: "err-1",
      outputFileId: "out-1",
    });
  });

  it("throws for terminal failure states", async () => {
    await expect(
      throwIfBatchTerminalFailure({
        provider: "voyage",
        readError: async () => "bad input",
        status: { error_file_id: "err-file", id: "b2", status: "failed" },
      }),
    ).rejects.toThrow("voyage batch b2 failed: bad input");
  });

  it("returns completed result directly without waiting", async () => {
    const waitForBatch = async () => ({ outputFileId: "out-2" });
    const result = await resolveCompletedBatchResult({
      provider: "openai",
      status: {
        id: "b3",
        output_file_id: "out-3",
        status: "completed",
      },
      wait: false,
      waitForBatch,
    });
    expect(result).toEqual({ errorFileId: undefined, outputFileId: "out-3" });
  });

  it("throws when wait disabled and batch is not complete", async () => {
    await expect(
      resolveCompletedBatchResult({
        provider: "openai",
        status: { id: "b4", status: "pending" },
        wait: false,
        waitForBatch: async () => ({ outputFileId: "out" }),
      }),
    ).rejects.toThrow("openai batch b4 submitted; enable remote.batch.wait to await completion");
  });
});
