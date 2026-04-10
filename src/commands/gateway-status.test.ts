import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayProbeResult } from "../gateway/probe.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";

let gatewayStatusCommand: typeof import("./gateway-status.js").gatewayStatusCommand;

const mocks = vi.hoisted(() => {
  const sshStop = vi.fn(async () => {});
  return {
    discoverGatewayBeacons: vi.fn(async (_opts?: unknown): Promise<GatewayBonjourBeacon[]> => []),
    loadGatewayTlsRuntime: vi.fn(
      async (): Promise<GatewayTlsRuntime> => ({
        enabled: true,
        fingerprintSha256: "sha256:local-fingerprint",
        required: true,
      }),
    ),
    pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10"),
    probeGateway: vi.fn(async (opts: { url: string }): Promise<GatewayProbeResult> => {
      const { url } = opts;
      if (url.includes("127.0.0.1")) {
        return {
          close: null,
          configSnapshot: {
            config: {
              gateway: { mode: "local" },
            },
            exists: true,
            issues: [],
            legacyIssues: [],
            path: "/tmp/cfg.json",
            valid: true,
          },
          connectLatencyMs: 12,
          error: null,
          health: { ok: true },
          ok: true,
          presence: [
            {
              mode: "gateway",
              reason: "self",
              host: "local",
              ip: "127.0.0.1",
              text: "Gateway: local (127.0.0.1) · app test · mode gateway · reason self",
              ts: Date.now(),
            },
          ],
          status: {
            linkChannel: {
              authAgeMs: null,
              id: "whatsapp",
              label: "WhatsApp",
              linked: false,
            },
            sessions: { count: 0 },
          },
          url,
        };
      }
      return {
        close: null,
        configSnapshot: {
          config: { gateway: { mode: "remote" } },
          exists: true,
          issues: [],
          legacyIssues: [],
          path: "/tmp/remote.json",
          valid: true,
        },
        connectLatencyMs: 34,
        error: null,
        health: { ok: true },
        ok: true,
        presence: [
          {
            mode: "gateway",
            reason: "self",
            host: "remote",
            ip: "100.64.0.2",
            text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
            ts: Date.now(),
          },
        ],
        status: {
          linkChannel: {
            authAgeMs: 5_000,
            id: "whatsapp",
            label: "WhatsApp",
            linked: true,
          },
          sessions: { count: 2 },
        },
        url,
      };
    }),
    readBestEffortConfig: vi.fn(async () => ({
      gateway: {
        auth: { token: "ltok" },
        mode: "remote",
        remote: { token: "rtok", url: "wss://remote.example:18789" },
      },
    })),
    resolveGatewayPort: vi.fn((_cfg?: unknown) => 18_789),
    resolveSshConfig: vi.fn(
      async (
        _opts?: unknown,
      ): Promise<{
        user: string;
        host: string;
        port: number;
        identityFiles: string[];
      } | null> => null,
    ),
    sshStop,
    startSshPortForward: vi.fn(async (_opts?: unknown) => ({
      localPort: 18789,
      parsedTarget: { host: "studio", port: 22, user: "me" },
      pid: 123,
      remotePort: 18789,
      stderr: [],
      stop: sshStop,
    })),
  };
});

const {
  readBestEffortConfig,
  discoverGatewayBeacons,
  pickPrimaryTailnetIPv4,
  sshStop,
  resolveSshConfig,
  startSshPortForward,
  loadGatewayTlsRuntime,
  probeGateway,
} = mocks;

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/bonjour-discovery.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/bonjour-discovery.js")>(
    "../infra/bonjour-discovery.js",
  );
  return {
    ...actual,
    discoverGatewayBeacons: mocks.discoverGatewayBeacons,
  };
});

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/ssh-tunnel.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/ssh-tunnel.js")>("../infra/ssh-tunnel.js");
  return {
    ...actual,
    startSshPortForward: mocks.startSshPortForward,
  };
});

vi.mock("../infra/ssh-config.js", () => ({
  resolveSshConfig: mocks.resolveSshConfig,
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: mocks.loadGatewayTlsRuntime,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

function createRuntimeCapture() {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const runtime = {
    error: (msg: string) => runtimeErrors.push(msg),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
    log: (msg: string) => runtimeLogs.push(msg),
  };
  return { runtime, runtimeErrors, runtimeLogs };
}

function asRuntimeEnv(runtime: ReturnType<typeof createRuntimeCapture>["runtime"]): RuntimeEnv {
  return runtime as unknown as RuntimeEnv;
}

function makeRemoteGatewayConfig(url: string, token = "rtok", localToken = "ltok") {
  return {
    gateway: {
      auth: { token: localToken },
      mode: "remote",
      remote: { token, url },
    },
  };
}

function mockLocalTokenEnvRefConfig(envTokenId = "MISSING_GATEWAY_TOKEN") {
  readBestEffortConfig.mockResolvedValueOnce({
    gateway: {
      auth: {
        mode: "token",
        token: { id: envTokenId, provider: "default", source: "env" },
      },
      mode: "local",
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as never);
}

async function runGatewayStatus(
  runtime: ReturnType<typeof createRuntimeCapture>["runtime"],
  opts: { timeout: string; json?: boolean; ssh?: string; sshAuto?: boolean; sshIdentity?: string },
) {
  await gatewayStatusCommand(opts, asRuntimeEnv(runtime));
}

function findUnresolvedSecretRefWarning(runtimeLogs: string[]) {
  const parsed = JSON.parse(runtimeLogs.join("\n")) as {
    warnings?: { code?: string; message?: string; targetIds?: string[] }[];
  };
  return parsed.warnings?.find(
    (warning) =>
      warning.code === "auth_secretref_unresolved" &&
      warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
  );
}

describe("gateway-status command", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ gatewayStatusCommand } = await import("./gateway-status.js"));
  });

  it("prints human output by default", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(runtimeLogs.join("\n")).toContain("Targets");
  });

  it("prints a structured JSON envelope when --json is set", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { json: true, timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.targets).toBeTruthy();
    const targets = parsed.targets as Record<string, unknown>[];
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets[0]?.health).toBeTruthy();
    expect(targets[0]?.summary).toBeTruthy();
  });

  it("omits discovery wsUrl when only TXT hints are present", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        displayName: "Gateway",
        gatewayPort: 19_443,
        instanceName: "gateway",
        lanHost: "attacker.example.com",
        tailnetDns: "attacker.tailnet.ts.net",
      },
    ]);

    await runGatewayStatus(runtime, { json: true, timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      discovery?: { beacons?: { wsUrl?: string | null }[] };
    };
    expect(parsed.discovery?.beacons?.[0]?.wsUrl).toBeNull();
  });

  it("keeps status output working when tailnet discovery throws", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    await runGatewayStatus(runtime, { json: true, timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      network?: { tailnetIPv4?: string | null; localTailnetUrl?: string | null };
    };
    expect(parsed.network).toMatchObject({
      localTailnetUrl: null,
      tailnetIPv4: null,
    });
  });

  it("treats missing-scope RPC probe failures as degraded but reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        auth: { mode: "token", token: "ltok" },
        mode: "local",
      },
    } as never);
    probeGateway.mockResolvedValueOnce({
      close: null,
      configSnapshot: null,
      connectLatencyMs: 51,
      error: "missing scope: operator.read",
      health: null,
      ok: false,
      presence: null,
      status: null,
      url: "ws://127.0.0.1:18789",
    });

    await runGatewayStatus(runtime, { json: true, timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      ok?: boolean;
      degraded?: boolean;
      warnings?: { code?: string; targetIds?: string[] }[];
      targets?: {
        connect?: {
          ok?: boolean;
          rpcOk?: boolean;
          scopeLimited?: boolean;
        };
      }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.degraded).toBe(true);
    expect(parsed.targets?.[0]?.connect).toMatchObject({
      ok: true,
      rpcOk: false,
      scopeLimited: true,
    });
    const scopeLimitedWarning = parsed.warnings?.find(
      (warning) => warning.code === "probe_scope_limited",
    );
    expect(scopeLimitedWarning?.targetIds).toContain("localLoopback");
  });

  it("suppresses unresolved SecretRef auth warnings when probe is reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      mockLocalTokenEnvRefConfig();

      await runGatewayStatus(runtime, { json: true, timeout: "1000" });
    });

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = findUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning).toBeUndefined();
  });

  it("surfaces unresolved SecretRef auth diagnostics when probe fails", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      mockLocalTokenEnvRefConfig();
      probeGateway.mockResolvedValueOnce({
        close: null,
        configSnapshot: null,
        connectLatencyMs: null,
        error: "connection refused",
        health: null,
        ok: false,
        presence: null,
        status: null,
        url: "ws://127.0.0.1:18789",
      });
      await expect(runGatewayStatus(runtime, { json: true, timeout: "1000" })).rejects.toThrow(
        "__exit__:1",
      );
    });

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = findUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning).toBeTruthy();
    expect(unresolvedWarning?.targetIds).toContain("localLoopback");
    expect(unresolvedWarning?.message).toContain("env:default:MISSING_GATEWAY_TOKEN");
    expect(unresolvedWarning?.message).not.toContain("missing or empty");
  });

  it("does not resolve local token SecretRef when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        MISSING_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      async () => {
        mockLocalTokenEnvRefConfig();

        await runGatewayStatus(runtime, { json: true, timeout: "1000" });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "env-token",
        }),
      }),
    );
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: { code?: string; message?: string }[];
    };
    const unresolvedWarning = parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
    );
    expect(unresolvedWarning).toBeUndefined();
  });

  it("does not resolve local password SecretRef in token mode", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        MISSING_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      async () => {
        readBestEffortConfig.mockResolvedValueOnce({
          gateway: {
            auth: {
              mode: "token",
              password: { id: "MISSING_GATEWAY_PASSWORD", provider: "default", source: "env" },
              token: "config-token",
            },
            mode: "local",
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as never);

        await runGatewayStatus(runtime, { json: true, timeout: "1000" });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: { code?: string; message?: string }[];
    };
    const unresolvedPasswordWarning = parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.password SecretRef is unresolved"),
    );
    expect(unresolvedPasswordWarning).toBeUndefined();
  });

  it("resolves env-template gateway.auth.token before probing targets", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        CUSTOM_GATEWAY_TOKEN: "resolved-gateway-token",
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        readBestEffortConfig.mockResolvedValueOnce({
          gateway: {
            auth: {
              mode: "token",
              token: "${CUSTOM_GATEWAY_TOKEN}",
            },
            mode: "local",
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as never);

        await runGatewayStatus(runtime, { json: true, timeout: "1000" });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "resolved-gateway-token",
        }),
      }),
    );
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: { code?: string }[];
    };
    const unresolvedWarning = parsed.warnings?.find(
      (warning) => warning.code === "auth_secretref_unresolved",
    );
    expect(unresolvedWarning).toBeUndefined();
  });

  it("emits stable SecretRef auth configuration booleans in --json output", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    const previousProbeImpl = probeGateway.getMockImplementation();
    probeGateway.mockImplementation(async (opts: { url: string }) => ({
      close: null,
      configSnapshot: {
        config: {
          discovery: {
            wideArea: { enabled: true },
          },
          gateway: {
            auth: {
              mode: "token",
              password: { id: "OPENCLAW_GATEWAY_PASSWORD", provider: "default", source: "env" },
              token: { id: "OPENCLAW_GATEWAY_TOKEN", provider: "default", source: "env" },
            },
            mode: "remote",
            remote: {
              password: { id: "REMOTE_GATEWAY_PASSWORD", provider: "default", source: "env" },
              token: { id: "REMOTE_GATEWAY_TOKEN", provider: "default", source: "env" },
              url: "wss://remote.example:18789",
            },
          },
          secrets: {
            defaults: {
              env: "default",
            },
          },
        },
        exists: true,
        issues: [],
        legacyIssues: [],
        path: "/tmp/secretref-config.json",
        valid: true,
      },
      connectLatencyMs: 20,
      error: null,
      health: { ok: true },
      ok: true,
      presence: [
        {
          host: "remote",
          ip: "100.64.0.2",
          mode: "gateway",
          reason: "self",
          text: "Gateway: remote (100.64.0.2) · app test · mode gateway · reason self",
          ts: Date.now(),
        },
      ],
      status: {
        linkChannel: {
          authAgeMs: 1000,
          id: "whatsapp",
          label: "WhatsApp",
          linked: true,
        },
        sessions: { count: 1 },
      },
      url: opts.url,
    }));

    try {
      await runGatewayStatus(runtime, { json: true, timeout: "1000" });
    } finally {
      if (previousProbeImpl) {
        probeGateway.mockImplementation(previousProbeImpl);
      } else {
        probeGateway.mockReset();
      }
    }

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      targets?: Record<string, unknown>[];
    };
    const configRemoteTarget = parsed.targets?.find((target) => target.kind === "configRemote");
    expect(configRemoteTarget?.config).toMatchInlineSnapshot(`
      {
        "discovery": {
          "wideAreaEnabled": true,
        },
        "exists": true,
        "gateway": {
          "authMode": "token",
          "authPasswordConfigured": true,
          "authTokenConfigured": true,
          "bind": null,
          "controlUiBasePath": null,
          "controlUiEnabled": null,
          "mode": "remote",
          "port": null,
          "remotePasswordConfigured": true,
          "remoteTokenConfigured": true,
          "remoteUrl": "wss://remote.example:18789",
          "tailscaleMode": null,
        },
        "issues": [],
        "legacyIssues": [],
        "path": "/tmp/secretref-config.json",
        "valid": true,
      }
    `);
  });

  it("supports SSH tunnel targets", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();

    startSshPortForward.mockClear();
    sshStop.mockClear();
    probeGateway.mockClear();

    await runGatewayStatus(runtime, { json: true, ssh: "me@studio", timeout: "1000" });

    expect(startSshPortForward).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalled();
    const tunnelCall = probeGateway.mock.calls.find(
      (call) => typeof call?.[0]?.url === "string" && call[0].url.startsWith("ws://127.0.0.1:"),
    )?.[0] as { auth?: { token?: string } } | undefined;
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(sshStop).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    const targets = parsed.targets as Record<string, unknown>[];
    expect(targets.some((t) => t.kind === "sshTunnel")).toBe(true);
  });

  it("uses local TLS target strategy and fingerprint for local loopback probes", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    loadGatewayTlsRuntime.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        auth: { mode: "token", token: "ltok" },
        mode: "local",
        tls: { enabled: true },
      },
    } as never);

    await runGatewayStatus(runtime, { json: true, timeout: "15000" });

    expect(loadGatewayTlsRuntime).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 15_000,
        tlsFingerprint: "sha256:local-fingerprint",
        url: "wss://127.0.0.1:18789",
      }),
    );
  });

  it("warns when local TLS is enabled but the certificate fingerprint cannot be loaded", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    probeGateway.mockClear();
    loadGatewayTlsRuntime.mockResolvedValueOnce({
      enabled: false,
      error: "gateway tls: cert/key missing",
      required: true,
    });
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        auth: { mode: "token", token: "ltok" },
        mode: "local",
        tls: { enabled: true },
      },
    } as never);

    await runGatewayStatus(runtime, { json: true, timeout: "15000" });

    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        tlsFingerprint: undefined,
        url: "wss://127.0.0.1:18789",
      }),
    );

    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      warnings?: { code?: string; message?: string; targetIds?: string[] }[];
    };
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({
        code: "local_tls_runtime_unavailable",
        targetIds: ["localLoopback"],
      }),
    );
    expect(
      parsed.warnings?.find((warning) => warning.code === "local_tls_runtime_unavailable")?.message,
    ).toContain("gateway tls: cert/key missing");
  });

  it("passes the full caller timeout through to local loopback probes", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        auth: { mode: "token", token: "ltok" },
        mode: "local",
      },
    } as never);

    await runGatewayStatus(runtime, { json: true, timeout: "15000" });

    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 15_000,
        url: "ws://127.0.0.1:18789",
      }),
    );
  });

  it("keeps inactive local loopback probes on the short timeout in remote mode", async () => {
    const { runtime } = createRuntimeCapture();
    probeGateway.mockClear();
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        auth: { mode: "token", token: "ltok" },
        mode: "remote",
        remote: {},
      },
    } as never);

    await runGatewayStatus(runtime, { json: true, timeout: "15000" });

    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 800,
        url: "ws://127.0.0.1:18789",
      }),
    );
  });

  it("does not infer ssh-auto targets from TXT-only discovery metadata", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(makeRemoteGatewayConfig("", "", "ltok"));
      discoverGatewayBeacons.mockResolvedValueOnce([
        { instanceName: "bad", tailnetDns: "-V" },
        { instanceName: "txt-only", tailnetDns: "goodhost" },
      ]);

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { json: true, sshAuto: true, timeout: "1000" });

      expect(startSshPortForward).not.toHaveBeenCalled();
    });
  });

  it("infers ssh-auto targets from resolved discovery hosts", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(makeRemoteGatewayConfig("", "", "ltok"));
      discoverGatewayBeacons.mockResolvedValueOnce([
        { instanceName: "bad", tailnetDns: "-V" },
        { host: "goodhost", instanceName: "Gateway", port: 18_789, sshPort: 2222 },
      ]);

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { json: true, sshAuto: true, timeout: "1000" });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as { target: string };
      expect(call.target).toBe("steipete@goodhost:2222");
    });
  });

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("ws://peters-mac-studio-1.sheep-coho.ts.net:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce({
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        identityFiles: ["/tmp/id_ed25519"],
        port: 2222,
        user: "steipete",
      });

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { json: true, timeout: "1000" });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
        identity?: string;
      };
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("wss://studio.example:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce(null);

      startSshPortForward.mockClear();
      await runGatewayStatus(runtime, { json: true, timeout: "1000" });

      const call = startSshPortForward.mock.calls[0]?.[0] as {
        target: string;
      };
      expect(call.target).toBe("studio.example");
    });
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    const { runtime } = createRuntimeCapture();

    readBestEffortConfig.mockResolvedValueOnce(
      makeRemoteGatewayConfig("wss://studio.example:18789"),
    );
    resolveSshConfig.mockResolvedValueOnce({
      host: "studio.example",
      identityFiles: ["/tmp/id_from_config"],
      port: 22,
      user: "me",
    });

    startSshPortForward.mockClear();
    await runGatewayStatus(runtime, {
      json: true,
      sshIdentity: "/tmp/explicit_id",
      timeout: "1000",
    });

    const call = startSshPortForward.mock.calls[0]?.[0] as {
      identity?: string;
    };
    expect(call.identity).toBe("/tmp/explicit_id");
  });
});
