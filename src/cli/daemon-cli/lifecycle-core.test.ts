import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  defaultRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  runtimeLogs,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>(() => ({
  gateway: {
    auth: {
      token: "config-token",
    },
  },
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

let runServiceRestart: typeof import("./lifecycle-core.js").runServiceRestart;
let runServiceStart: typeof import("./lifecycle-core.js").runServiceStart;
let runServiceStop: typeof import("./lifecycle-core.js").runServiceStop;

function readJsonLog<T extends object>() {
  const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

function createServiceRunArgs(checkTokenDrift?: boolean) {
  return {
    opts: { json: true as const },
    renderStartHints: () => [],
    service,
    serviceNoun: "Gateway",
    ...(checkTokenDrift ? { checkTokenDrift } : {}),
  };
}

describe("runServiceRestart token drift", () => {
  beforeAll(async () => {
    ({ runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js"));
  });

  beforeEach(() => {
    resetLifecycleRuntimeLogs();
    loadConfig.mockReset();
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    resetLifecycleServiceMocks();
    service.readCommand.mockResolvedValue({
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
      programArguments: [],
    });
    stubEmptyGatewayEnv();
  });

  it("prints the container restart hint when restart is requested for a not-loaded service", async () => {
    service.isLoaded.mockResolvedValue(false);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "openclaw-demo-container");

    await runServiceRestart({
      opts: { json: false },
      renderStartHints: () => [
        "Restart the container or the service that manages it for openclaw-demo-container.",
        "openclaw gateway install",
      ],
      service,
      serviceNoun: "Gateway",
    });

    expect(runtimeLogs).toContain("Gateway service not loaded.");
    expect(runtimeLogs).toContain(
      "Start with: Restart the container or the service that manages it for openclaw-demo-container.",
    );
  });

  it("emits drift warning when enabled", async () => {
    await runServiceRestart(createServiceRunArgs(true));

    expect(loadConfig).toHaveBeenCalledTimes(1);
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("gateway install --force")]),
    );
  });

  it("compares restart drift against config token even when caller env is set", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "config-token",
        },
      },
    });
    service.readCommand.mockResolvedValue({
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
      programArguments: [],
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("gateway install --force")]),
    );
  });

  it("resolves config token SecretRefs using service command env before drift checks", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
          token: {
            id: "SERVICE_GATEWAY_TOKEN",
            provider: "default",
            source: "env",
          },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    service.readCommand.mockResolvedValue({
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "service-token",
        SERVICE_GATEWAY_TOKEN: "service-token",
      },
      programArguments: [],
    });

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("prefers service command env over process env for SecretRef token drift resolution", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
          token: {
            id: "SERVICE_GATEWAY_TOKEN",
            provider: "default",
            source: "env",
          },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });
    service.readCommand.mockResolvedValue({
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "service-token",
        SERVICE_GATEWAY_TOKEN: "service-token",
      },
      programArguments: [],
    });
    vi.stubEnv("SERVICE_GATEWAY_TOKEN", "process-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("skips drift warning when disabled", async () => {
    await runServiceRestart({
      opts: { json: true },
      renderStartHints: () => [],
      service,
      serviceNoun: "Node",
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    const payload = readJsonLog<{ warnings?: string[] }>();
    expect(payload.warnings).toBeUndefined();
  });

  it("emits stopped when an unmanaged process handles stop", async () => {
    service.isLoaded.mockResolvedValue(false);

    await runServiceStop({
      onNotLoaded: async () => ({
        message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
        result: "stopped",
      }),
      opts: { json: true },
      service,
      serviceNoun: "Gateway",
    });

    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("stopped");
    expect(payload.message).toContain("unmanaged process");
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("emits started when a not-loaded start path repairs the service", async () => {
    service.isLoaded.mockResolvedValue(false);

    await runServiceStart({
      onNotLoaded: async () => ({
        loaded: true,
        message:
          "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
        result: "started",
      }),
      opts: { json: true },
      renderStartHints: () => [],
      service,
      serviceNoun: "Gateway",
    });

    const payload = readJsonLog<{
      result?: string;
      message?: string;
      service?: { loaded?: boolean };
    }>();
    expect(payload.result).toBe("started");
    expect(payload.message).toContain("re-bootstrapped");
    expect(payload.service?.loaded).toBe(true);
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("runs restart health checks after an unmanaged restart signal", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);

    await runServiceRestart({
      onNotLoaded: async () => ({
        message: "Gateway restart signal sent to unmanaged process on port 18789: 4200.",
        result: "restarted",
      }),
      opts: { json: true },
      postRestartCheck,
      renderStartHints: () => [],
      service,
      serviceNoun: "Gateway",
    });

    expect(postRestartCheck).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("restarted");
    expect(payload.message).toContain("unmanaged process");
  });

  it("emits loaded restart state when launchd repair handles a not-loaded restart", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.isLoaded.mockResolvedValue(false);

    await runServiceRestart({
      onNotLoaded: async () => ({
        loaded: true,
        message:
          "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
        result: "restarted",
      }),
      opts: { json: true },
      postRestartCheck,
      renderStartHints: () => [],
      service,
      serviceNoun: "Gateway",
    });

    expect(postRestartCheck).toHaveBeenCalledTimes(1);
    expect(service.restart).not.toHaveBeenCalled();
    const payload = readJsonLog<{
      result?: string;
      message?: string;
      service?: { loaded?: boolean };
    }>();
    expect(payload.result).toBe("restarted");
    expect(payload.message).toContain("re-bootstrapped");
    expect(payload.service?.loaded).toBe(true);
  });

  it("skips restart health checks when restart is only scheduled", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    const result = await runServiceRestart({
      opts: { json: true },
      postRestartCheck,
      renderStartHints: () => [],
      service,
      serviceNoun: "Gateway",
    });

    expect(result).toBe(true);
    expect(postRestartCheck).not.toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });

  it("emits scheduled when service start routes through a scheduled restart", async () => {
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    await runServiceStart({
      opts: { json: true },
      renderStartHints: () => [],
      service,
      serviceNoun: "Gateway",
    });

    expect(service.isLoaded).toHaveBeenCalled();
    const payload = readJsonLog<{ result?: string; message?: string }>();
    expect(payload.result).toBe("scheduled");
    expect(payload.message).toBe("restart scheduled, gateway will restart momentarily");
  });

  it("fails start when restarting a stopped installed service errors", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.restart.mockRejectedValue(new Error("launchctl kickstart failed: permission denied"));

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    const payload = readJsonLog<{ ok?: boolean; error?: string }>();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("launchctl kickstart failed: permission denied");
  });

  it("falls back to not-loaded hints when start finds no install artifacts", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await runServiceStart({
      opts: { json: true },
      renderStartHints: () => ["openclaw gateway install"],
      service,
      serviceNoun: "Gateway",
    });

    const payload = readJsonLog<{
      ok?: boolean;
      result?: string;
      hints?: string[];
      hintItems?: { kind: string; text: string }[];
    }>();
    expect(payload.ok).toBe(true);
    expect(payload.result).toBe("not-loaded");
    expect(payload.hints).toEqual(expect.arrayContaining(["openclaw gateway install"]));
    expect(payload.hintItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "install",
          text: "openclaw gateway install",
        }),
      ]),
    );
    expect(service.restart).not.toHaveBeenCalled();
  });
});
