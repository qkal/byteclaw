import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  computeSinceTimestamp,
  readNostrBusState,
  readNostrProfileState,
  writeNostrBusState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

async function withTempStateDir<T>(fn: (dir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  setNostrRuntime({
    state: {
      resolveStateDir: (env, homedir) => {
        const stateEnv = env ?? process.env;
        const override = stateEnv.OPENCLAW_STATE_DIR?.trim();
        if (override) {
          return override;
        }
        const resolveHome = homedir ?? os.homedir;
        return path.join(resolveHome(), ".openclaw");
      },
    },
  } as PluginRuntime);
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await fs.rm(dir, { force: true, recursive: true });
  }
}

describe("nostr bus state store", () => {
  it("persists and reloads state across restarts", async () => {
    await withTempStateDir(async () => {
      // Fresh start - no state
      expect(await readNostrBusState({ accountId: "test-bot" })).toBeNull();

      // Write state
      await writeNostrBusState({
        accountId: "test-bot",
        gatewayStartedAt: 1_700_000_100,
        lastProcessedAt: 1_700_000_000,
      });

      // Read it back
      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        gatewayStartedAt: 1_700_000_100,
        lastProcessedAt: 1_700_000_000,
        recentEventIds: [],
        version: 2,
      });
    });
  });

  it("isolates state by accountId", async () => {
    await withTempStateDir(async () => {
      await writeNostrBusState({
        accountId: "bot-a",
        gatewayStartedAt: 1000,
        lastProcessedAt: 1000,
      });
      await writeNostrBusState({
        accountId: "bot-b",
        gatewayStartedAt: 2000,
        lastProcessedAt: 2000,
      });

      const stateA = await readNostrBusState({ accountId: "bot-a" });
      const stateB = await readNostrBusState({ accountId: "bot-b" });

      expect(stateA?.lastProcessedAt).toBe(1000);
      expect(stateB?.lastProcessedAt).toBe(2000);
    });
  });

  it("upgrades v1 bus state files on read", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "nostr", "bus-state-test-bot.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          gatewayStartedAt: 1_700_000_100,
          lastProcessedAt: 1_700_000_000,
          version: 1,
        }),
        "utf8",
      );

      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        gatewayStartedAt: 1_700_000_100,
        lastProcessedAt: 1_700_000_000,
        recentEventIds: [],
        version: 2,
      });
    });
  });

  it("drops malformed recent event ids while keeping the state", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "nostr", "bus-state-test-bot.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          gatewayStartedAt: 1_700_000_100,
          lastProcessedAt: 1_700_000_000,
          recentEventIds: ["evt-1", 2, null],
          version: 2,
        }),
        "utf8",
      );

      const state = await readNostrBusState({ accountId: "test-bot" });
      expect(state).toEqual({
        gatewayStartedAt: 1_700_000_100,
        lastProcessedAt: 1_700_000_000,
        recentEventIds: ["evt-1"],
        version: 2,
      });
    });
  });
});

describe("nostr profile state store", () => {
  it("persists and reloads profile publish state", async () => {
    await withTempStateDir(async () => {
      await writeNostrProfileState({
        accountId: "test-bot",
        lastPublishResults: {
          "wss://relay.example": "ok",
        },
        lastPublishedAt: 1_700_000_000,
        lastPublishedEventId: "evt-1",
      });

      const state = await readNostrProfileState({ accountId: "test-bot" });
      expect(state).toEqual({
        lastPublishResults: {
          "wss://relay.example": "ok",
        },
        lastPublishedAt: 1_700_000_000,
        lastPublishedEventId: "evt-1",
        version: 1,
      });
    });
  });

  it("drops malformed relay results while keeping valid state fields", async () => {
    await withTempStateDir(async (dir) => {
      const filePath = path.join(dir, "nostr", "profile-state-test-bot.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          lastPublishResults: {
            "wss://relay.bad": "unknown",
            "wss://relay.example": "ok",
          },
          lastPublishedAt: 1_700_000_000,
          lastPublishedEventId: "evt-1",
          version: 1,
        }),
        "utf8",
      );

      const state = await readNostrProfileState({ accountId: "test-bot" });
      expect(state).toEqual({
        lastPublishResults: null,
        lastPublishedAt: 1_700_000_000,
        lastPublishedEventId: "evt-1",
        version: 1,
      });
    });
  });
});

describe("computeSinceTimestamp", () => {
  it("returns now for null state (fresh start)", () => {
    const now = 1_700_000_000;
    expect(computeSinceTimestamp(null, now)).toBe(now);
  });

  it("uses lastProcessedAt when available", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      gatewayStartedAt: null,
      lastProcessedAt: 1_699_999_000,
      recentEventIds: [],
      version: 2,
    };
    expect(computeSinceTimestamp(state, 1_700_000_000)).toBe(1_699_999_000);
  });

  it("uses gatewayStartedAt when lastProcessedAt is null", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      gatewayStartedAt: 1_699_998_000,
      lastProcessedAt: null,
      recentEventIds: [],
      version: 2,
    };
    expect(computeSinceTimestamp(state, 1_700_000_000)).toBe(1_699_998_000);
  });

  it("uses the max of both timestamps", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      gatewayStartedAt: 1_699_998_000,
      lastProcessedAt: 1_699_999_000,
      recentEventIds: [],
      version: 2,
    };
    expect(computeSinceTimestamp(state, 1_700_000_000)).toBe(1_699_999_000);
  });

  it("falls back to now if both are null", () => {
    const state: Parameters<typeof computeSinceTimestamp>[0] = {
      gatewayStartedAt: null,
      lastProcessedAt: null,
      recentEventIds: [],
      version: 2,
    };
    expect(computeSinceTimestamp(state, 1_700_000_000)).toBe(1_700_000_000);
  });
});
