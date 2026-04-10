import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";

describe("Matrix inbound event dedupe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function createStoragePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-inbound-dedupe-"));
    tempDirs.push(dir);
    return path.join(dir, "inbound-dedupe.json");
  }

  const auth = {
    accessToken: "token",
    accountId: "ops",
    deviceId: "DEVICE",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
  } as const;

  it("persists committed events across restarts", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ eventId: "$event-1", roomId: "!room:example.org" })).toBe(true);
    await first.commitEvent({
      eventId: "$event-1",
      roomId: "!room:example.org",
    });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ eventId: "$event-1", roomId: "!room:example.org" })).toBe(false);
  });

  it("does not persist released pending claims", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ eventId: "$event-2", roomId: "!room:example.org" })).toBe(true);
    first.releaseEvent({ eventId: "$event-2", roomId: "!room:example.org" });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ eventId: "$event-2", roomId: "!room:example.org" })).toBe(true);
  });

  it("prunes expired and overflowed entries on load", async () => {
    const storagePath = createStoragePath();
    fs.writeFileSync(
      storagePath,
      JSON.stringify({
        entries: [
          { key: "!room:example.org|$old", ts: 10 },
          { key: "!room:example.org|$keep-1", ts: 90 },
          { key: "!room:example.org|$keep-2", ts: 95 },
          { key: "!room:example.org|$keep-3", ts: 100 },
        ],
        version: 1,
      }),
      "utf8",
    );

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      maxEntries: 2,
      nowMs: () => 100,
      storagePath,
      ttlMs: 20,
    });

    expect(deduper.claimEvent({ eventId: "$old", roomId: "!room:example.org" })).toBe(true);
    expect(deduper.claimEvent({ eventId: "$keep-1", roomId: "!room:example.org" })).toBe(true);
    expect(deduper.claimEvent({ eventId: "$keep-2", roomId: "!room:example.org" })).toBe(false);
    expect(deduper.claimEvent({ eventId: "$keep-3", roomId: "!room:example.org" })).toBe(false);
  });

  it("retains replayed backlog events based on processing time", async () => {
    const storagePath = createStoragePath();
    let now = 100;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      nowMs: () => now,
      storagePath,
      ttlMs: 20,
    });

    expect(first.claimEvent({ eventId: "$backlog", roomId: "!room:example.org" })).toBe(true);
    await first.commitEvent({
      eventId: "$backlog",
      roomId: "!room:example.org",
    });
    await first.stop();

    now = 110;
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      nowMs: () => now,
      storagePath,
      ttlMs: 20,
    });
    expect(second.claimEvent({ eventId: "$backlog", roomId: "!room:example.org" })).toBe(false);
  });

  it("treats stop persistence failures as best-effort cleanup", async () => {
    const blockingPath = createStoragePath();
    fs.writeFileSync(blockingPath, "blocking file", "utf8");
    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath: path.join(blockingPath, "nested", "inbound-dedupe.json"),
    });

    expect(deduper.claimEvent({ eventId: "$persist-fail", roomId: "!room:example.org" })).toBe(
      true,
    );
    await deduper.commitEvent({
      eventId: "$persist-fail",
      roomId: "!room:example.org",
    });

    await expect(deduper.stop()).resolves.toBeUndefined();
  });
});
