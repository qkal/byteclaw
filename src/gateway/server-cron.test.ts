import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
} = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
  enqueueSystemEventMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  loadConfigMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow,
    }),
  ));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
    session: {
      mainKey: "main",
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      broadcast: () => {},
      cfg,
      deps: {} as CliDeps,
    });
    try {
      const job = await state.cron.add({
        enabled: true,
        name: "canonicalize-session-key",
        payload: { kind: "systemEvent", text: "hello" },
        schedule: { at: new Date(1).toISOString(), kind: "at" },
        sessionKey: "discord:channel:ops",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      broadcast: () => {},
      cfg,
      deps: {} as CliDeps,
    });
    try {
      const job = await state.cron.add({
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
        enabled: true,
        name: "ssrf-webhook-blocked",
        payload: { kind: "systemEvent", text: "hello" },
        schedule: { at: new Date(1).toISOString(), kind: "at" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        init: {
          body: expect.stringContaining('"action":"finished"'),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: expect.any(AbortSignal),
        },
        url: "http://127.0.0.1:8080/cron-finished",
      });
    } finally {
      state.cron.stop();
    }
  });

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
    const cfg = {
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
      session: {
        mainKey: "main",
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      broadcast: () => {},
      cfg,
      deps: {} as CliDeps,
    });
    try {
      const job = await state.cron.add({
        enabled: true,
        name: "custom-session",
        payload: { kind: "agentTurn", message: "hello" },
        schedule: { at: new Date(1).toISOString(), kind: "at" },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        onWarn: expect.any(Function),
        sessionKeys: ["project-alpha-monitor"],
      });
    } finally {
      state.cron.stop();
    }
  });

  it("uses a dedicated cron session key for isolated jobs with model overrides", async () => {
    const cfg = createCronConfig("server-cron-isolated-key");
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      broadcast: () => {},
      cfg,
      deps: {} as CliDeps,
    });
    try {
      const job = await state.cron.add({
        enabled: true,
        name: "isolated-model-override",
        payload: {
          kind: "agentTurn",
          message: "run report",
          model: "ollama/kimi-k2.5:cloud",
        },
        schedule: { at: new Date(1).toISOString(), kind: "at" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: `cron:${job.id}`,
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "main",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        onWarn: expect.any(Function),
        sessionKeys: [`cron:${job.id}`],
      });
    } finally {
      state.cron.stop();
    }
  });
});
