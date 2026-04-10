import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRuntime,
  mockSessionsConfig,
  runSessionsJson,
  writeStore,
} from "./sessions.test-helpers.js";

// Disable colors for deterministic snapshots.
process.env.FORCE_COLOR = "0";

mockSessionsConfig();

import { sessionsCommand } from "./sessions.js";

describe("sessionsCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a tabular view with token percentages", async () => {
    const store = writeStore({
      "+15555550123": {
        inputTokens: 1200,
        model: "pi:opus",
        outputTokens: 800,
        sessionId: "abc123",
        totalTokens: 2000,
        totalTokensFresh: true,
        updatedAt: Date.now() - 45 * 60_000,
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    const tableHeader = logs.find((line) => line.includes("Tokens (ctx %"));
    expect(tableHeader).toBeTruthy();

    const row = logs.find((line) => line.includes("+15555550123")) ?? "";
    expect(row).toContain("2.0k/32k (6%)");
    expect(row).toContain("45m ago");
    expect(row).toContain("pi:opus");
  });

  it("shows placeholder rows when tokens are missing", async () => {
    const store = writeStore({
      "discord:group:demo": {
        sessionId: "xyz",
        thinkingLevel: "high",
        updatedAt: Date.now() - 5 * 60_000,
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    const row = logs.find((line) => line.includes("discord:group:demo")) ?? "";
    expect(row).toContain("unknown/32k (?%)");
    expect(row).toContain("think:high");
    expect(row).toContain("5m ago");
  });

  it("exports freshness metadata in JSON output", async () => {
    const store = writeStore({
      "discord:group:demo": {
        inputTokens: 20,
        model: "pi:opus",
        outputTokens: 10,
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
      },
      main: {
        inputTokens: 1200,
        model: "pi:opus",
        outputTokens: 800,
        sessionId: "abc123",
        totalTokens: 2000,
        totalTokensFresh: true,
        updatedAt: Date.now() - 10 * 60_000,
      },
    });

    const payload = await runSessionsJson<{
      sessions?: {
        key: string;
        totalTokens: number | null;
        totalTokensFresh: boolean;
      }[];
    }>(sessionsCommand, store);
    const main = payload.sessions?.find((row) => row.key === "main");
    const group = payload.sessions?.find((row) => row.key === "discord:group:demo");
    expect(main?.totalTokens).toBe(2000);
    expect(main?.totalTokensFresh).toBe(true);
    expect(group?.totalTokens).toBeNull();
    expect(group?.totalTokensFresh).toBe(false);
  });

  it("applies --active filtering in JSON output", async () => {
    const store = writeStore(
      {
        recent: {
          model: "pi:opus",
          sessionId: "recent",
          updatedAt: Date.now() - 5 * 60_000,
        },
        stale: {
          model: "pi:opus",
          sessionId: "stale",
          updatedAt: Date.now() - 45 * 60_000,
        },
      },
      "sessions-active",
    );

    const payload = await runSessionsJson<{
      sessions?: {
        key: string;
      }[];
    }>(sessionsCommand, store, { active: "10" });
    expect(payload.sessions?.map((row) => row.key)).toEqual(["recent"]);
  });

  it("rejects invalid --active values", async () => {
    const store = writeStore(
      {
        demo: {
          sessionId: "demo",
          updatedAt: Date.now() - 5 * 60_000,
        },
      },
      "sessions-active-invalid",
    );
    const { runtime, errors } = makeRuntime();

    await expect(sessionsCommand({ active: "0", store }, runtime)).rejects.toThrow("exit 1");
    expect(errors[0]).toContain("--active must be a positive integer");

    fs.rmSync(store);
  });
});
