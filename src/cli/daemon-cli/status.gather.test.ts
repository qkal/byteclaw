import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { captureEnv } from "../../test-utils/env.js";
import type { GatewayRestartSnapshot } from "./restart-health.js";
import { gatherDaemonStatus } from "./status.gather.js";

const callGatewayStatusProbe = vi.fn<
  (opts?: unknown) => Promise<{ ok: boolean; url?: string; error?: string | null }>
>(async (_opts?: unknown) => ({
  error: null,
  ok: true,
  url: "ws://127.0.0.1:19001",
}));
const loadGatewayTlsRuntime = vi.fn(async (_cfg?: unknown) => ({
  enabled: true,
  fingerprintSha256: "sha256:11:22:33:44",
  required: true,
}));
const findExtraGatewayServices = vi.fn(async (_env?: unknown, _opts?: unknown) => []);
const inspectPortUsage = vi.fn(async (port: number) => ({
  hints: [],
  listeners: [],
  port,
  status: "free" as const,
}));
const readLastGatewayErrorLine = vi.fn(async (_env?: NodeJS.ProcessEnv) => null);
const auditGatewayServiceConfig = vi.fn(async (_opts?: unknown) => undefined);
const serviceIsLoaded = vi.fn(async (_opts?: unknown) => true);
const serviceReadRuntime = vi.fn(async (_env?: NodeJS.ProcessEnv) => ({ status: "running" }));
const inspectGatewayRestart = vi.fn<(opts?: unknown) => Promise<GatewayRestartSnapshot>>(
  async (_opts?: unknown) => ({
    healthy: true,
    portUsage: { hints: [], listeners: [], port: 19_001, status: "busy" },
    runtime: { pid: 1234, status: "running" },
    staleGatewayPids: [],
  }),
);
const serviceReadCommand = vi.fn<
  (env?: NodeJS.ProcessEnv) => Promise<{
    programArguments: string[];
    environment?: Record<string, string>;
  }>
>(async (_env?: NodeJS.ProcessEnv) => ({
  environment: {
    OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
    OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
  },
  programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
}));
const resolveGatewayBindHost = vi.fn(
  async (_bindMode?: string, _customBindHost?: string) => "0.0.0.0",
);
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.9");
const resolveGatewayPort = vi.fn((_cfg?: unknown, _env?: unknown) => 18_789);
const resolveStateDir = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-cli",
);
const resolveConfigPath = vi.fn((env: NodeJS.ProcessEnv, stateDir: string) => env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`);
const readConfigFileSnapshotCalls = vi.fn((configPath: string) => configPath);
const loadConfigCalls = vi.fn((configPath: string) => configPath);
let daemonLoadedConfig: Record<string, unknown> = {
  gateway: {
    auth: { token: "daemon-token" },
    bind: "lan",
    tls: { enabled: true },
  },
};
let cliLoadedConfig: Record<string, unknown> = {
  gateway: {
    bind: "loopback",
  },
};

vi.mock("../../config/config.js", () => ({
  createConfigIO: ({ configPath }: { configPath: string }) => {
    const isDaemon = configPath.includes("/openclaw-daemon/");
    const runtimeConfig = isDaemon ? daemonLoadedConfig : cliLoadedConfig;
    return {
      loadConfig: () => {
        loadConfigCalls(configPath);
        return runtimeConfig;
      },
      readConfigFileSnapshot: async () => {
        readConfigFileSnapshotCalls(configPath);
        return {
          config: runtimeConfig,
          exists: true,
          issues: [],
          path: configPath,
          runtimeConfig,
          valid: true,
        };
      },
    };
  },
  loadConfig: () => cliLoadedConfig,
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
  resolveStateDir: (env: NodeJS.ProcessEnv) => resolveStateDir(env),
}));

vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: (env: NodeJS.ProcessEnv) => readLastGatewayErrorLine(env),
}));

vi.mock("../../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
}));

vi.mock("../../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: (opts: unknown) => auditGatewayServiceConfig(opts),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () =>
    createMockGatewayService({
      isLoaded: serviceIsLoaded,
      readCommand: serviceReadCommand,
      readRuntime: serviceReadRuntime,
    }),
}));

vi.mock("../../gateway/net.js", () => ({
  resolveGatewayBindHost: (bindMode: string, customBindHost?: string) =>
    resolveGatewayBindHost(bindMode, customBindHost),
}));

vi.mock("../../infra/ports.js", () => ({
  formatPortDiagnostics: () => [],
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (cfg: unknown) => loadGatewayTlsRuntime(cfg),
}));

vi.mock("./probe.js", () => ({
  probeGatewayStatus: (opts: unknown) => callGatewayStatusProbe(opts),
}));

vi.mock("./restart-health.js", () => ({
  inspectGatewayRestart: (opts: unknown) => inspectGatewayRestart(opts),
}));

describe("gatherDaemonStatus", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "DAEMON_GATEWAY_TOKEN",
      "DAEMON_GATEWAY_PASSWORD",
    ]);
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-cli";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-cli/openclaw.json";
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.DAEMON_GATEWAY_TOKEN;
    delete process.env.DAEMON_GATEWAY_PASSWORD;
    callGatewayStatusProbe.mockClear();
    loadGatewayTlsRuntime.mockClear();
    inspectGatewayRestart.mockClear();
    readConfigFileSnapshotCalls.mockClear();
    loadConfigCalls.mockClear();
    daemonLoadedConfig = {
      gateway: {
        auth: { token: "daemon-token" },
        bind: "lan",
        tls: { enabled: true },
      },
    };
    cliLoadedConfig = {
      gateway: {
        bind: "loopback",
      },
    };
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("uses wss probe URL and forwards TLS fingerprint when daemon TLS is enabled", async () => {
    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(loadGatewayTlsRuntime).toHaveBeenCalledTimes(1);
    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        tlsFingerprint: "sha256:11:22:33:44",
        token: "daemon-token",
        url: "wss://127.0.0.1:19001",
      }),
    );
    expect(status.gateway?.probeUrl).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.url).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.ok).toBe(true);
  });

  it("forwards requireRpc and configPath to the daemon probe", async () => {
    await gatherDaemonStatus({
      deep: false,
      probe: true,
      requireRpc: true,
      rpc: {},
    });

    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/openclaw-daemon/openclaw.json",
        requireRpc: true,
      }),
    );
  });

  it("reuses the shared CLI config snapshot when the daemon uses the same config path", async () => {
    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
    });

    await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(readConfigFileSnapshotCalls).toHaveBeenCalledTimes(1);
    expect(readConfigFileSnapshotCalls).toHaveBeenCalledWith("/tmp/openclaw-cli/openclaw.json");
    expect(loadConfigCalls).not.toHaveBeenCalled();
  });

  it("defaults unset daemon bind mode to loopback for host-side status reporting", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: { token: "daemon-token" },
        tls: { enabled: true },
      },
    };

    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
    expect(status.gateway?.bindMode).toBe("loopback");
  });

  it("does not force local TLS fingerprint when probe URL is explicitly overridden", async () => {
    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: { url: "wss://override.example:18790" },
    });

    expect(loadGatewayTlsRuntime).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        tlsFingerprint: undefined,
        url: "wss://override.example:18790",
      }),
    );
    expect(status.gateway?.probeUrl).toBe("wss://override.example:18790");
    expect(status.rpc?.url).toBe("wss://override.example:18790");
  });

  it("uses fallback network details when interface discovery throws during status inspection", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: { token: "daemon-token" },
        bind: "tailnet",
        tls: { enabled: true },
      },
    };
    resolveGatewayBindHost.mockImplementationOnce(async () => {
      throw new Error("uv_interface_addresses failed");
    });
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(status.gateway).toMatchObject({
      bindHost: "127.0.0.1",
      bindMode: "tailnet",
      probeUrl: "wss://127.0.0.1:19001",
    });
    expect(status.gateway?.probeNote).toContain("interface discovery failed");
    expect(status.gateway?.probeNote).toContain("tailnet addresses");
  });

  it("reuses command environment when reading runtime status", async () => {
    serviceReadCommand.mockResolvedValueOnce({
      environment: {
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "19001",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
      } as Record<string, string>,
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
    });
    serviceReadRuntime.mockImplementationOnce(async (env?: NodeJS.ProcessEnv) => ({
      detail: env?.OPENCLAW_GATEWAY_PORT ?? "missing-port",
      status: env?.OPENCLAW_GATEWAY_PORT === "19001" ? "running" : "unknown",
    }));

    const status = await gatherDaemonStatus({
      deep: false,
      probe: false,
      rpc: {},
    });

    expect(serviceReadRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENCLAW_GATEWAY_PORT: "19001",
      }),
    );
    expect(status.service.runtime).toMatchObject({
      detail: "19001",
      status: "running",
    });
  });

  it("resolves daemon gateway auth password SecretRef values before probing", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: {
          password: { id: "DAEMON_GATEWAY_PASSWORD", provider: "default", source: "env" },
        },
        bind: "lan",
        tls: { enabled: true },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    process.env.DAEMON_GATEWAY_PASSWORD = "daemon-secretref-password"; // Pragma: allowlist secret

    await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "daemon-secretref-password", // Pragma: allowlist secret
      }),
    );
  });

  it("resolves daemon gateway auth token SecretRef values before probing", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "${DAEMON_GATEWAY_TOKEN}",
        },
        bind: "lan",
        tls: { enabled: true },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    process.env.DAEMON_GATEWAY_TOKEN = "daemon-secretref-token";

    await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "daemon-secretref-token",
      }),
    );
  });

  it("does not resolve daemon password SecretRef when token auth is configured", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: {
          mode: "token",
          password: { id: "MISSING_DAEMON_GATEWAY_PASSWORD", provider: "default", source: "env" },
          token: "daemon-token",
        },
        bind: "lan",
        tls: { enabled: true },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        password: undefined,
        token: "daemon-token",
      }),
    );
  });

  it("degrades safely when daemon probe auth SecretRef is unresolved", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_DAEMON_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
        bind: "lan",
        tls: { enabled: true },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };

    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        password: undefined,
        token: undefined,
      }),
    );
    expect(status.rpc?.authWarning).toBeUndefined();
  });

  it("surfaces authWarning when daemon probe auth SecretRef is unresolved and probe fails", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_DAEMON_GATEWAY_TOKEN", provider: "default", source: "env" },
        },
        bind: "lan",
        tls: { enabled: true },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    callGatewayStatusProbe.mockResolvedValueOnce({
      error: "gateway closed",
      ok: false,
      url: "wss://127.0.0.1:19001",
    });

    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(status.rpc?.ok).toBe(false);
    expect(status.rpc?.authWarning).toContain(
      "gateway.auth.token SecretRef is unresolved in this command path",
    );
    expect(status.rpc?.authWarning).toContain("probing without configured auth credentials");
  });

  it("keeps remote probe auth strict when remote token is missing", async () => {
    daemonLoadedConfig = {
      gateway: {
        auth: {
          mode: "token",
          password: "local-password",
          token: "local-token", // Pragma: allowlist secret
        },
        mode: "remote",
        remote: {
          password: "remote-password",
          url: "wss://gateway.example", // Pragma: allowlist secret
        },
      },
    };
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "env-password"; // Pragma: allowlist secret

    await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "env-password",
        token: undefined, // Pragma: allowlist secret
      }),
    );
  });

  it("skips TLS runtime loading when probe is disabled", async () => {
    const status = await gatherDaemonStatus({
      deep: false,
      probe: false,
      rpc: {},
    });

    expect(loadGatewayTlsRuntime).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).not.toHaveBeenCalled();
    expect(status.rpc).toBeUndefined();
  });

  it("surfaces stale gateway listener pids from restart health inspection", async () => {
    inspectGatewayRestart.mockResolvedValueOnce({
      healthy: false,
      portUsage: {
        hints: [],
        listeners: [{ commandLine: "openclaw-gateway", pid: 9000, ppid: 8999 }],
        port: 19_001,
        status: "busy",
      },
      runtime: { pid: 8000, status: "running" },
      staleGatewayPids: [9000],
    });

    const status = await gatherDaemonStatus({
      deep: false,
      probe: true,
      rpc: {},
    });

    expect(inspectGatewayRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 19_001,
      }),
    );
    expect(status.health).toEqual({
      healthy: false,
      staleGatewayPids: [9000],
    });
  });
});
