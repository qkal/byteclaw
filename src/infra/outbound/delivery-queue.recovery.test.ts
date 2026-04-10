import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_RETRIES,
  enqueueDelivery,
  loadPendingDeliveries,
  recoverPendingDeliveries,
} from "./delivery-queue.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const baseCfg = {};

  const enqueueCrashRecoveryEntries = async () => {
    await enqueueDelivery(
      { channel: "demo-channel-a", payloads: [{ text: "a" }], to: "+1" },
      tmpDir(),
    );
    await enqueueDelivery(
      { channel: "demo-channel-b", payloads: [{ text: "b" }], to: "2" },
      tmpDir(),
    );
  };

  const runRecovery = async ({
    deliver,
    log = createRecoveryLog(),
    maxRecoveryMs,
  }: {
    deliver: ReturnType<typeof vi.fn>;
    log?: ReturnType<typeof createRecoveryLog>;
    maxRecoveryMs?: number;
  }) => {
    const result = await recoverPendingDeliveries({
      cfg: baseCfg,
      deliver: asDeliverFn(deliver),
      log,
      stateDir: tmpDir(),
      ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
    });
    return { log, result };
  };

  it("recovers entries from a simulated crash", async () => {
    await enqueueCrashRecoveryEntries();
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      deferredBackoff: 0,
      failed: 0,
      recovered: 2,
      skippedMaxRetries: 0,
    });

    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("moves entries that exceeded max retries to failed/", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", payloads: [{ text: "a" }], to: "+1" },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });

    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
  });

  it("increments retryCount on failed recovery attempt", async () => {
    await enqueueDelivery(
      { channel: "demo-channel-c", payloads: [{ text: "x" }], to: "#ch" },
      tmpDir(),
    );

    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = await runRecovery({ deliver });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);

    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
  });

  it("moves entries to failed/ immediately on permanent delivery errors", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel", payloads: [{ text: "hi" }], to: "user:abc" },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(new Error("No conversation reference found for user:abc"));
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
  });

  it("treats Matrix 'User not in room' as a permanent error", async () => {
    const id = await enqueueDelivery(
      { channel: "matrix", payloads: [{ text: "hi" }], to: "!lowercased:matrix.example.com" },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "MatrixError: [403] User @bot:matrix.example.com not in room !lowercased:matrix.example.com",
        ),
      );
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
  });

  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    await enqueueDelivery(
      { channel: "demo-channel-a", payloads: [{ text: "a" }], to: "+1" },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ skipQueue: true }));
  });

  it("replays stored delivery options during recovery", async () => {
    await enqueueDelivery(
      {
        bestEffort: true,
        channel: "demo-channel-a",
        gatewayClientScopes: ["operator.write"],
        gifPlayback: true,
        mirror: {
          mediaUrls: ["https://example.com/a.png"],
          sessionKey: "agent:main:main",
          text: "a",
        },
        payloads: [{ text: "a" }],
        silent: true,
        to: "+1",
      },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffort: true,
        gatewayClientScopes: ["operator.write"],
        gifPlayback: true,
        mirror: {
          mediaUrls: ["https://example.com/a.png"],
          sessionKey: "agent:main:main",
          text: "a",
        },
        silent: true,
      }),
    );
  });

  it("respects maxRecoveryMs time budget and bumps deferred retries", async () => {
    await enqueueCrashRecoveryEntries();
    await enqueueDelivery(
      { channel: "demo-channel-c", payloads: [{ text: "c" }], to: "#c" },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 0,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      deferredBackoff: 0,
      failed: 0,
      recovered: 0,
      skippedMaxRetries: 0,
    });

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(3);
    expect(remaining.every((entry) => entry.retryCount === 1)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next startup"));
  });

  it("defers entries until backoff becomes eligible", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", payloads: [{ text: "a" }], to: "+1" },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { lastAttemptAt: Date.now(), retryCount: 3 });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 60_000,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      deferredBackoff: 1,
      failed: 0,
      recovered: 0,
      skippedMaxRetries: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
  });

  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueueDelivery(
      { channel: "demo-channel-a", payloads: [{ text: "blocked" }], to: "+1" },
      tmpDir(),
    );
    const readyId = await enqueueDelivery(
      { channel: "demo-channel-b", payloads: [{ text: "ready" }], to: "2" },
      tmpDir(),
    );

    setQueuedEntryState(tmpDir(), blockedId, {
      enqueuedAt: now - 30_000,
      lastAttemptAt: now,
      retryCount: 3,
    });
    setQueuedEntryState(tmpDir(), readyId, { enqueuedAt: now - 10_000, retryCount: 0 });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });

    expect(result).toEqual({
      deferredBackoff: 1,
      failed: 0,
      recovered: 1,
      skippedMaxRetries: 0,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "demo-channel-b", skipQueue: true, to: "2" }),
    );

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(blockedId);
  });

  it("recovers deferred entries on a later restart once backoff elapsed", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const id = await enqueueDelivery(
      { channel: "demo-channel-a", payloads: [{ text: "later" }], to: "+1" },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { lastAttemptAt: start.getTime(), retryCount: 3 });

    const firstDeliver = vi.fn().mockResolvedValue([]);
    const firstRun = await runRecovery({ deliver: firstDeliver, maxRecoveryMs: 60_000 });
    expect(firstRun.result).toEqual({
      deferredBackoff: 1,
      failed: 0,
      recovered: 0,
      skippedMaxRetries: 0,
    });
    expect(firstDeliver).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(start.getTime() + 600_000 + 1));
    const secondDeliver = vi.fn().mockResolvedValue([]);
    const secondRun = await runRecovery({ deliver: secondDeliver, maxRecoveryMs: 60_000 });
    expect(secondRun.result).toEqual({
      deferredBackoff: 0,
      failed: 0,
      recovered: 1,
      skippedMaxRetries: 0,
    });
    expect(secondDeliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);

    vi.useRealTimers();
  });

  it("returns zeros when queue is empty", async () => {
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(result).toEqual({
      deferredBackoff: 0,
      failed: 0,
      recovered: 0,
      skippedMaxRetries: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
