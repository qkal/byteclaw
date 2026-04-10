import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      list: [{ id: "main" }, { id: "opus" }],
    },
    session: {},
  })),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({ store: {}, storePath: "(multiple)" })),
  };
});

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    discoverAllSessions: vi.fn(async (params?: { agentId?: string }) => {
      if (params?.agentId === "main") {
        return [
          {
            firstUserMessage: "hello",
            mtime: 100,
            sessionFile: "/tmp/agents/main/sessions/s-main.jsonl",
            sessionId: "s-main",
          },
        ];
      }
      if (params?.agentId === "opus") {
        return [
          {
            firstUserMessage: "hi",
            mtime: 200,
            sessionFile: "/tmp/agents/opus/sessions/s-opus.jsonl",
            sessionId: "s-opus",
          },
        ];
      }
      return [];
    }),
    loadSessionCostSummary: vi.fn(async () => ({
      cacheRead: 0,
      cacheReadCost: 0,
      cacheWrite: 0,
      cacheWriteCost: 0,
      input: 0,
      inputCost: 0,
      missingCostEntries: 0,
      output: 0,
      outputCost: 0,
      totalCost: 0,
      totalTokens: 0,
    })),
    loadSessionLogs: vi.fn(async () => []),
    loadSessionUsageTimeSeries: vi.fn(async () => ({
      points: [],
      sessionId: "s-opus",
    })),
  };
});

import {
  discoverAllSessions,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "../../infra/session-cost-usage.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { usageHandlers } from "./usage.js";

async function runSessionsUsage(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage"]({
    params,
    respond,
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  return respond;
}

async function runSessionsUsageTimeseries(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.timeseries"]({
    params,
    respond,
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.timeseries"]>[0]);
  return respond;
}

async function runSessionsUsageLogs(params: Record<string, unknown>) {
  const respond = vi.fn();
  await usageHandlers["sessions.usage.logs"]({
    params,
    respond,
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage.logs"]>[0]);
  return respond;
}

const BASE_USAGE_RANGE = {
  endDate: "2026-02-02",
  limit: 10,
  startDate: "2026-02-01",
} as const;

function expectSuccessfulSessionsUsage(
  respond: ReturnType<typeof vi.fn>,
): { key: string; agentId: string }[] {
  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  const result = respond.mock.calls[0]?.[1] as {
    sessions: { key: string; agentId: string }[];
  };
  return result.sessions;
}

describe("sessions.usage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("discovers sessions across configured agents and keeps agentId in key", async () => {
    const respond = await runSessionsUsage(BASE_USAGE_RANGE);

    expect(vi.mocked(discoverAllSessions)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(discoverAllSessions).mock.calls[0]?.[0]?.agentId).toBe("main");
    expect(vi.mocked(discoverAllSessions).mock.calls[1]?.[0]?.agentId).toBe("opus");

    const sessions = expectSuccessfulSessionsUsage(respond);
    expect(sessions).toHaveLength(2);

    // Sorted by most recent first (mtime=200 -> opus first).
    expect(sessions[0].key).toBe("agent:opus:s-opus");
    expect(sessions[0].agentId).toBe("opus");
    expect(sessions[1].key).toBe("agent:main:s-main");
    expect(sessions[1].agentId).toBe("main");
  });

  it("resolves store entries by sessionId when queried via discovered agent-prefixed key", async () => {
    const storeKey = "agent:opus:slack:dm:u123";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "s-opus.jsonl");
        fs.writeFileSync(sessionFile, "", "utf8");

        // Swap the store mock for this test: the canonical key differs from the discovered key
        // But points at the same sessionId.
        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          store: {
            [storeKey]: {
              label: "Named session",
              sessionFile: "s-opus.jsonl",
              sessionId: "s-opus",
              updatedAt: 999,
            },
          },
          storePath: "(multiple)",
        });

        // Query via discovered key: agent:<id>:<sessionId>
        const respond = await runSessionsUsage({ ...BASE_USAGE_RANGE, key: "agent:opus:s-opus" });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(storeKey);
        expect(vi.mocked(loadSessionCostSummary)).toHaveBeenCalled();
        expect(
          vi.mocked(loadSessionCostSummary).mock.calls.some((call) => call[0]?.agentId === "opus"),
        ).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("prefers the deterministic store key when duplicate sessionIds exist", async () => {
    const preferredKey = "agent:opus:acp:run-dup";
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-usage-test-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const agentSessionsDir = path.join(stateDir, "agents", "opus", "sessions");
        fs.mkdirSync(agentSessionsDir, { recursive: true });
        const sessionFile = path.join(agentSessionsDir, "run-dup.jsonl");
        fs.writeFileSync(sessionFile, "", "utf8");

        vi.mocked(loadCombinedSessionStoreForGateway).mockReturnValue({
          store: {
            [preferredKey]: {
              sessionFile: "run-dup.jsonl",
              sessionId: "run-dup",
              updatedAt: 1_000,
            },
            "agent:other:main": {
              sessionFile: "run-dup.jsonl",
              sessionId: "run-dup",
              updatedAt: 2_000,
            },
          },
          storePath: "(multiple)",
        });

        const respond = await runSessionsUsage({
          ...BASE_USAGE_RANGE,
          key: "agent:opus:run-dup",
        });
        const sessions = expectSuccessfulSessionsUsage(respond);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.key).toBe(preferredKey);
      });
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("rejects traversal-style keys in specific session usage lookups", async () => {
    const respond = await runSessionsUsage({
      ...BASE_USAGE_RANGE,
      key: "agent:opus:../../etc/passwd",
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const error = respond.mock.calls[0]?.[2] as { message?: string } | undefined;
    expect(error?.message).toContain("Invalid session reference");
  });

  it("passes parsed agentId into sessions.usage.timeseries", async () => {
    await runSessionsUsageTimeseries({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionUsageTimeSeries)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionUsageTimeSeries).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("passes parsed agentId into sessions.usage.logs", async () => {
    await runSessionsUsageLogs({
      key: "agent:opus:s-opus",
    });

    expect(vi.mocked(loadSessionLogs)).toHaveBeenCalled();
    expect(vi.mocked(loadSessionLogs).mock.calls[0]?.[0]?.agentId).toBe("opus");
  });

  it("rejects traversal-style keys in timeseries/log lookups", async () => {
    const timeseriesRespond = await runSessionsUsageTimeseries({
      key: "agent:opus:../../etc/passwd",
    });
    expect(timeseriesRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Invalid session key"),
      }),
    );

    const logsRespond = await runSessionsUsageLogs({
      key: "agent:opus:../../etc/passwd",
    });
    expect(logsRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Invalid session key"),
      }),
    );
  });
});
