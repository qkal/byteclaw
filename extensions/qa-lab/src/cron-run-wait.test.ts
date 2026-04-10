import { describe, expect, it, vi } from "vitest";
import { waitForCronRunCompletion } from "./cron-run-wait.js";

describe("waitForCronRunCompletion", () => {
  it("ignores older entries and returns the newly finished run", async () => {
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockResolvedValueOnce({
        entries: [{ status: "ok", summary: "older run", ts: 100 }],
      })
      .mockResolvedValueOnce({
        entries: [{ status: "ok", summary: "new run", ts: 180 }],
      });

    const result = await waitForCronRunCompletion({
      afterTs: 150,
      callGateway,
      intervalMs: 0,
      jobId: "dreaming-job",
      timeoutMs: 100,
    });

    expect(result).toMatchObject({ status: "ok", summary: "new run", ts: 180 });
    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      "cron.runs",
      { id: "dreaming-job", limit: 20, sortDir: "desc" },
      { timeoutMs: 100 },
    );
  });

  it("surfaces recent run history on timeout", async () => {
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockResolvedValue({
        entries: [{ status: "ok", summary: "older run", ts: 100 }],
      });

    await expect(
      waitForCronRunCompletion({
        afterTs: 150,
        callGateway,
        intervalMs: 0,
        jobId: "dreaming-job",
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timed out waiting for cron run completion/);
  });
});
