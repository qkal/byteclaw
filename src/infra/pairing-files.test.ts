import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneExpiredPending,
  reconcilePendingPairingRequests,
  resolvePairingPaths,
} from "./pairing-files.js";

describe("pairing file helpers", () => {
  it("resolves pairing file paths from explicit base dirs", () => {
    expect(resolvePairingPaths("/tmp/openclaw-state", "devices")).toEqual({
      dir: path.join("/tmp/openclaw-state", "devices"),
      pairedPath: path.join("/tmp/openclaw-state", "devices", "paired.json"),
      pendingPath: path.join("/tmp/openclaw-state", "devices", "pending.json"),
    });
  });

  it("prunes only entries older than the ttl", () => {
    const pendingById = {
      edge: { requestId: "edge", ts: 50 },
      fresh: { requestId: "fresh", ts: 70 },
      stale: { requestId: "stale", ts: 10 },
    };

    pruneExpiredPending(pendingById, 100, 50);

    expect(pendingById).toEqual({
      edge: { requestId: "edge", ts: 50 },
      fresh: { requestId: "fresh", ts: 70 },
    });
  });

  it("refreshes a single matching pending request in place", async () => {
    const persist = vi.fn(async () => undefined);
    const existing = { deviceId: "device-1", requestId: "req-1", ts: 1, version: 1 };
    const pendingById = { "req-1": existing };

    await expect(
      reconcilePendingPairingRequests({
        buildReplacement: vi.fn(() => ({ deviceId: "device-1", requestId: "req-2", ts: 2 })),
        canRefreshSingle: () => true,
        existing: [existing],
        incoming: { version: 2 },
        pendingById,
        persist,
        refreshSingle: (pending, incoming) => ({ ...pending, ts: 2, version: incoming.version }),
      }),
    ).resolves.toEqual({
      created: false,
      request: { deviceId: "device-1", requestId: "req-1", ts: 2, version: 2 },
      status: "pending",
    });
    expect(persist).toHaveBeenCalledOnce();
  });

  it("replaces existing pending requests with one merged request", async () => {
    const persist = vi.fn(async () => undefined);
    const pendingById = {
      "req-1": { deviceId: "device-2", requestId: "req-1", ts: 1 },
      "req-2": { deviceId: "device-2", requestId: "req-2", ts: 2 },
    };

    await expect(
      reconcilePendingPairingRequests({
        buildReplacement: vi.fn(() => ({
          deviceId: "device-2",
          isRepair: true,
          requestId: "req-3",
          ts: 3,
        })),
        canRefreshSingle: () => false,
        existing: Object.values(pendingById).toSorted((left, right) => right.ts - left.ts),
        incoming: { deviceId: "device-2" },
        pendingById,
        persist,
        refreshSingle: (pending) => pending,
      }),
    ).resolves.toEqual({
      created: true,
      request: { deviceId: "device-2", isRepair: true, requestId: "req-3", ts: 3 },
      status: "pending",
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(pendingById).toEqual({
      "req-3": { deviceId: "device-2", isRepair: true, requestId: "req-3", ts: 3 },
    });
  });
});
