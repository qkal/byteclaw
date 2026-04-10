import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const loadConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    agents: {
      defaults: {
        contextTokens: 32_000,
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
      },
      list: [
        { default: false, id: "main" },
        { default: true, id: "voice" },
      ],
    },
    session: {
      store: "/tmp/sessions-{agentId}.json",
    },
  })),
);

const resolveStorePathMock = vi.hoisted(() =>
  vi.fn(
    (_store: string | undefined, opts?: { agentId?: string }) =>
      `/tmp/sessions-${opts?.agentId ?? "missing"}.json`,
  ),
);
const loadSessionStoreMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    loadSessionStore: loadSessionStoreMock,
    resolveStorePath: resolveStorePathMock,
  };
});

import { sessionsCommand } from "./sessions.js";

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    runtime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: (msg: unknown) => logs.push(String(msg)),
    },
  };
}

describe("sessionsCommand default store agent selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(() => ({
      agents: {
        defaults: {
          contextTokens: 32_000,
          model: { primary: "pi:opus" },
          models: { "pi:opus": {} },
        },
        list: [
          { default: false, id: "main" },
          { default: true, id: "voice" },
        ],
      },
      session: {
        store: "/tmp/sessions-{agentId}.json",
      },
    }));
    resolveStorePathMock.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) =>
        `/tmp/sessions-${opts?.agentId ?? "missing"}.json`,
    );
    loadSessionStoreMock.mockImplementation(() => ({}));
  });

  it("includes agentId on sessions rows for --all-agents JSON output", async () => {
    resolveStorePathMock.mockClear();
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock
      .mockReturnValueOnce({
        main_row: { model: "pi:opus", sessionId: "s1", updatedAt: Date.now() - 60_000 },
      })
      .mockReturnValueOnce({
        voice_row: { model: "pi:opus", sessionId: "s2", updatedAt: Date.now() - 120_000 },
      });
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      allAgents?: boolean;
      sessions?: { key: string; agentId?: string }[];
    };
    expect(payload.allAgents).toBe(true);
    expect(payload.sessions?.map((session) => session.agentId)).toContain("main");
    expect(payload.sessions?.map((session) => session.agentId)).toContain("voice");
  });

  it("avoids duplicate rows when --all-agents resolves to a shared store path", async () => {
    loadConfigMock.mockImplementation(() => ({
      agents: {
        defaults: {
          contextTokens: 32_000,
          model: { primary: "pi:opus" },
          models: { "pi:opus": {} },
        },
        list: [
          { default: false, id: "main" },
          { default: true, id: "voice" },
        ],
      },
      session: {
        store: "/tmp/shared-sessions.json",
      },
    }));
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({
      "agent:main:room": { model: "pi:opus", sessionId: "s1", updatedAt: Date.now() - 60_000 },
      "agent:voice:room": { model: "pi:opus", sessionId: "s2", updatedAt: Date.now() - 30_000 },
    });
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      count?: number;
      stores?: { agentId: string; path: string }[];
      allAgents?: boolean;
      sessions?: { key: string; agentId?: string }[];
    };
    expect(payload.count).toBe(2);
    expect(payload.allAgents).toBe(true);
    expect(payload.stores).toEqual([{ agentId: "main", path: "/tmp/shared-sessions.json" }]);
    expect(payload.sessions?.map((session) => session.agentId).toSorted()).toEqual([
      "main",
      "voice",
    ]);
    expect(loadSessionStoreMock).toHaveBeenCalledTimes(1);
  });

  it("uses configured default agent id when resolving implicit session store path", async () => {
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({});
    const { runtime, logs } = createRuntime();

    await sessionsCommand({}, runtime);

    expect(loadSessionStoreMock).toHaveBeenCalledWith("/tmp/sessions-voice.json");
    expect(logs[0]).toContain("Session store: /tmp/sessions-voice.json");
  });

  it("uses all configured agent stores with --all-agents", async () => {
    loadSessionStoreMock.mockReset();
    loadSessionStoreMock
      .mockReturnValueOnce({
        main_row: { model: "pi:opus", sessionId: "s1", updatedAt: Date.now() - 60_000 },
      })
      .mockReturnValueOnce({});
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true }, runtime);

    expect(loadSessionStoreMock).toHaveBeenNthCalledWith(1, "/tmp/sessions-main.json");
    expect(loadSessionStoreMock).toHaveBeenNthCalledWith(2, "/tmp/sessions-voice.json");
    expect(logs[0]).toContain("Session stores: 2 (main, voice)");
    expect(logs[2]).toContain("Agent");
  });
});
