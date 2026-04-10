import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  loadConfigMock as loadConfig,
  pickPrimaryLanIPv4Mock as pickPrimaryLanIPv4,
  pickPrimaryTailnetIPv4Mock as pickPrimaryTailnetIPv4,
  resolveGatewayPortMock as resolveGatewayPort,
} from "./gateway-connection.test-mocks.js";

const deviceIdentityState = vi.hoisted(() => ({
  throwOnLoad: false,
  value: {
    deviceId: "test-device-identity",
    privateKeyPem: "test-private-key",
    publicKeyPem: "test-public-key",
  } satisfies DeviceIdentity,
}));

let lastClientOptions: {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  clientDisplayName?: string;
  scopes?: string[];
  deviceIdentity?: unknown;
  onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
  onClose?: (code: number, reason: string) => void;
} | null = null;
let lastRequestOptions: {
  method?: string;
  params?: unknown;
  opts?: { expectFinal?: boolean; timeoutMs?: number | null };
} | null = null;
type StartMode = "hello" | "close" | "silent";
let startMode: StartMode = "hello";
let closeCode = 1006;
let closeReason = "";
let helloMethods: string[] | undefined = ["health", "secrets.resolve"];

vi.mock("./client.js", () => ({
  GatewayClient: class {
    constructor(opts: {
      url?: string;
      token?: string;
      password?: string;
      clientDisplayName?: string;
      scopes?: string[];
      onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
      onClose?: (code: number, reason: string) => void;
    }) {
      lastClientOptions = opts;
    }
    async request(
      method: string,
      params: unknown,
      opts?: { expectFinal?: boolean; timeoutMs?: number | null },
    ) {
      lastRequestOptions = { method, opts, params };
      return { ok: true };
    }
    start() {
      if (startMode === "hello") {
        void lastClientOptions?.onHelloOk?.({
          features: {
            methods: helloMethods,
          },
        });
      } else if (startMode === "close") {
        lastClientOptions?.onClose?.(closeCode, closeReason);
      }
    }
    stop() {}
  },
  describeGatewayCloseCode: (code: number) => {
    if (code === 1000) {
      return "normal closure";
    }
    if (code === 1006) {
      return "abnormal closure (no close frame)";
    }
    return undefined;
  },
}));

const { __testing, buildGatewayConnectionDetails, callGateway, callGatewayCli, callGatewayScoped } =
  await import("./call.js");

class StubGatewayClient {
  constructor(opts: {
    url?: string;
    token?: string;
    password?: string;
    clientDisplayName?: string;
    scopes?: string[];
    onHelloOk?: (hello: { features?: { methods?: string[] } }) => void | Promise<void>;
    onClose?: (code: number, reason: string) => void;
  }) {
    lastClientOptions = opts;
  }
  async request(
    method: string,
    params: unknown,
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ) {
    lastRequestOptions = { method, opts, params };
    return { ok: true };
  }
  start() {
    if (startMode === "hello") {
      void lastClientOptions?.onHelloOk?.({
        features: {
          methods: helloMethods,
        },
      });
    } else if (startMode === "close") {
      lastClientOptions?.onClose?.(closeCode, closeReason);
    }
  }
  stop() {}
}

function resetGatewayCallMocks() {
  loadConfig.mockClear();
  resolveGatewayPort.mockClear();
  pickPrimaryTailnetIPv4.mockClear();
  pickPrimaryLanIPv4.mockClear();
  lastClientOptions = null;
  lastRequestOptions = null;
  startMode = "hello";
  closeCode = 1006;
  closeReason = "";
  helloMethods = ["health", "secrets.resolve"];
  const loadConfigForTests = loadConfig as unknown as () => OpenClawConfig;
  const resolveGatewayPortForTests = resolveGatewayPort as unknown as (
    cfg?: OpenClawConfig,
    env?: NodeJS.ProcessEnv,
  ) => number;
  __testing.setDepsForTests({
    createGatewayClient: (opts) =>
      new StubGatewayClient(opts as ConstructorParameters<typeof StubGatewayClient>[0]) as never,
    loadConfig: loadConfigForTests,
    loadOrCreateDeviceIdentity: () => {
      if (deviceIdentityState.throwOnLoad) {
        throw new Error("read-only identity dir");
      }
      return deviceIdentityState.value;
    },
    resolveGatewayPort: resolveGatewayPortForTests,
  });
  deviceIdentityState.throwOnLoad = false;
}

function setGatewayNetworkDefaults(port = 18_789) {
  resolveGatewayPort.mockReturnValue(port);
  pickPrimaryTailnetIPv4.mockReturnValue(undefined);
}

function setLocalLoopbackGatewayConfig(port = 18_789) {
  loadConfig.mockReturnValue({ gateway: { bind: "loopback", mode: "local" } });
  setGatewayNetworkDefaults(port);
}

function makeRemotePasswordGatewayConfig(remotePassword: string, localPassword = "from-config") {
  return {
    gateway: {
      auth: { password: localPassword },
      mode: "remote",
      remote: { password: remotePassword, url: "wss://remote.example:18789" },
    },
  };
}

describe("callGateway url resolution", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_STATE_DIR",
  ]);

  beforeEach(() => {
    envSnapshot.restore();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_STATE_DIR;
    resetGatewayCallMocks();
  });

  afterEach(() => {
    envSnapshot.restore();
    __testing.resetDepsForTests();
  });

  it.each([
    {
      label: "keeps loopback when local bind is auto even if tailnet is present",
      tailnetIp: "100.64.0.1",
    },
    {
      label: "falls back to loopback when local bind is auto without tailnet IP",
      tailnetIp: undefined,
    },
  ])("local auto-bind: $label", async ({ tailnetIp }) => {
    loadConfig.mockReturnValue({ gateway: { bind: "auto", mode: "local" } });
    resolveGatewayPort.mockReturnValue(18_800);
    pickPrimaryTailnetIPv4.mockReturnValue(tailnetIp);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
  });

  it.each([
    {
      expectedUrl: "wss://127.0.0.1:18800",
      gateway: { bind: "tailnet", mode: "local", tls: { enabled: true } },
      label: "tailnet with TLS",
      lanIp: undefined,
      tailnetIp: "100.64.0.1",
    },
    {
      expectedUrl: "ws://127.0.0.1:18800",
      gateway: { bind: "tailnet", mode: "local" },
      label: "tailnet without TLS",
      lanIp: undefined,
      tailnetIp: "100.64.0.1",
    },
    {
      expectedUrl: "wss://127.0.0.1:18800",
      gateway: { bind: "lan", mode: "local", tls: { enabled: true } },
      label: "lan with TLS",
      lanIp: "192.168.1.42",
      tailnetIp: undefined,
    },
    {
      expectedUrl: "ws://127.0.0.1:18800",
      gateway: { bind: "lan", mode: "local" },
      label: "lan without TLS",
      lanIp: "192.168.1.42",
      tailnetIp: undefined,
    },
    {
      expectedUrl: "ws://127.0.0.1:18800",
      gateway: { bind: "lan", mode: "local" },
      label: "lan without discovered LAN IP",
      lanIp: undefined,
      tailnetIp: undefined,
    },
  ])("uses loopback for $label", async ({ gateway, tailnetIp, lanIp, expectedUrl }) => {
    loadConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18_800);
    pickPrimaryTailnetIPv4.mockReturnValue(tailnetIp);
    pickPrimaryLanIPv4.mockReturnValue(lanIp);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.url).toBe(expectedUrl);
  });

  it("uses url override in remote mode even when remote url is missing", async () => {
    loadConfig.mockReturnValue({
      gateway: { bind: "loopback", mode: "remote", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({
      method: "health",
      token: "explicit-token",
      url: "wss://override.example/ws",
    });

    expect(lastClientOptions?.url).toBe("wss://override.example/ws");
    expect(lastClientOptions?.token).toBe("explicit-token");
  });

  it("skips config loading when explicit url and token are provided", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("loadConfig should not run");
    });

    await callGatewayCli({
      method: "health",
      token: "test-token",
      url: "ws://127.0.0.1:18800",
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18800");
    expect(lastClientOptions?.token).toBe("test-token");
  });

  it("keeps device identity enabled for local loopback shared-token auth", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({
      method: "health",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    setLocalLoopbackGatewayConfig();
    deviceIdentityState.throwOnLoad = true;

    await callGateway({
      method: "health",
      token: "explicit-token",
    });

    expect(lastClientOptions?.url).toBe("ws://127.0.0.1:18789");
    expect(lastClientOptions?.token).toBe("explicit-token");
    expect(lastClientOptions?.deviceIdentity).toBeNull();
    expect(lastRequestOptions?.method).toBe("health");
  });

  it("uses OPENCLAW_GATEWAY_URL env override in remote mode when remote URL is missing", async () => {
    loadConfig.mockReturnValue({
      gateway: { bind: "loopback", mode: "remote", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.url).toBe("wss://gateway-in-container.internal:9443/ws");
    expect(lastClientOptions?.token).toBe("env-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("uses env URL override credentials without resolving local password SecretRefs", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "password",
          password: { id: "MISSING_LOCAL_PASSWORD", provider: "default", source: "env" },
        },
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);
    resolveGatewayPort.mockReturnValue(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.url).toBe("wss://gateway-in-container.internal:9443/ws");
    expect(lastClientOptions?.token).toBe("env-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("uses remote tlsFingerprint with env URL override", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: {
          tlsFingerprint: "remote-fingerprint",
          url: "wss://remote.example:9443/ws",
        },
      },
    });
    setGatewayNetworkDefaults(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-in-container.internal:9443/ws";
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    await callGateway({
      method: "health",
    });

    expect(lastClientOptions?.tlsFingerprint).toBe("remote-fingerprint");
  });

  it("does not apply remote tlsFingerprint for CLI url override", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: {
          tlsFingerprint: "remote-fingerprint",
          url: "wss://remote.example:9443/ws",
        },
      },
    });
    setGatewayNetworkDefaults(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    await callGateway({
      method: "health",
      token: "explicit-token",
      url: "wss://override.example:9443/ws",
    });

    expect(lastClientOptions?.tlsFingerprint).toBeUndefined();
  });

  it.each([
    {
      call: () => callGateway({ method: "health" }),
      expectedScopes: ["operator.read"],
      label: "uses least-privilege scopes by default for non-CLI callers",
    },
    {
      call: () => callGatewayCli({ method: "health" }),
      expectedScopes: [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
        "operator.talk.secrets",
      ],
      label: "keeps legacy admin scopes for explicit CLI callers",
    },
  ])("scope selection: $label", async ({ call, expectedScopes }) => {
    setLocalLoopbackGatewayConfig();
    await call();
    expect(lastClientOptions?.scopes).toEqual(expectedScopes);
  });

  it("passes explicit scopes through, including empty arrays", async () => {
    setLocalLoopbackGatewayConfig();

    await callGatewayScoped({ method: "health", scopes: ["operator.read"] });
    expect(lastClientOptions?.scopes).toEqual(["operator.read"]);

    await callGatewayScoped({ method: "health", scopes: [] });
    expect(lastClientOptions?.scopes).toEqual([]);
  });

  it("labels default backend calls with the requested method", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "sessions.delete" });

    expect(lastClientOptions?.clientDisplayName).toBe("gateway:sessions.delete");
  });

  it("does not synthesize display names for CLI calls", async () => {
    setLocalLoopbackGatewayConfig();

    await callGatewayCli({ method: "health" });

    expect(lastClientOptions?.clientDisplayName).toBeUndefined();
  });

  it("yields one event-loop turn before starting CLI pairing requests", async () => {
    setLocalLoopbackGatewayConfig();

    let preConnectYieldRan = false;
    let sawYieldBeforeStart = false;
    setImmediate(() => {
      preConnectYieldRan = true;
    });

    __testing.setDepsForTests({
      createGatewayClient: (opts) =>
        ({
          async request(
            method: string,
            params: unknown,
            requestOpts?: { expectFinal?: boolean; timeoutMs?: number | null },
          ) {
            lastRequestOptions = { method, opts: requestOpts, params };
            return { ok: true };
          },
          start() {
            sawYieldBeforeStart = preConnectYieldRan;
            void opts.onHelloOk?.({
              features: {
                events: [],
                methods: helloMethods ?? [],
              },
            } as unknown as Parameters<NonNullable<typeof opts.onHelloOk>>[0]);
          },
          stop() {},
        }) as never,
      loadConfig: loadConfig as unknown as () => OpenClawConfig,
      loadOrCreateDeviceIdentity: () => deviceIdentityState.value,
      resolveGatewayPort: resolveGatewayPort as unknown as (
        cfg?: OpenClawConfig,
        env?: NodeJS.ProcessEnv,
      ) => number,
    });

    await callGateway({
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      method: "device.pair.list",
      mode: GATEWAY_CLIENT_MODES.CLI,
    });

    expect(sawYieldBeforeStart).toBe(true);
  });
});

describe("buildGatewayConnectionDetails", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  it("uses explicit url overrides and omits bind details", () => {
    setLocalLoopbackGatewayConfig(18_800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    const details = buildGatewayConnectionDetails({
      url: "wss://example.com/ws",
    });

    expect(details.url).toBe("wss://example.com/ws");
    expect(details.urlSource).toBe("cli --url");
    expect(details.bindDetail).toBeUndefined();
    expect(details.remoteFallbackNote).toBeUndefined();
    expect(details.message).toContain("Gateway target: wss://example.com/ws");
    expect(details.message).toContain("Source: cli --url");
  });

  it("emits a remote fallback note when remote url is missing", () => {
    loadConfig.mockReturnValue({
      gateway: { bind: "loopback", mode: "remote", remote: {} },
    });
    resolveGatewayPort.mockReturnValue(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
    expect(details.urlSource).toBe("missing gateway.remote.url (fallback local)");
    expect(details.bindDetail).toBe("Bind: loopback");
    expect(details.remoteFallbackNote).toContain(
      "gateway.mode=remote but gateway.remote.url is missing",
    );
    expect(details.message).toContain("Gateway target: ws://127.0.0.1:18789");
  });

  it.each([
    {
      expectedUrl: "wss://127.0.0.1:18800",
      gateway: { bind: "lan", mode: "local", tls: { enabled: true } },
      label: "with TLS",
    },
    {
      expectedUrl: "ws://127.0.0.1:18800",
      gateway: { bind: "lan", mode: "local" },
      label: "without TLS",
    },
  ])("uses loopback URL for bind=lan $label", ({ gateway, expectedUrl }) => {
    loadConfig.mockReturnValue({ gateway });
    resolveGatewayPort.mockReturnValue(18_800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue("10.0.0.5");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe(expectedUrl);
    expect(details.urlSource).toBe("local loopback");
    expect(details.bindDetail).toBe("Bind: lan");
  });

  it("prefers remote url when configured", () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "tailnet",
        mode: "remote",
        remote: { url: "wss://remote.example.com/ws" },
      },
    });
    resolveGatewayPort.mockReturnValue(18_800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.9");

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("wss://remote.example.com/ws");
    expect(details.urlSource).toBe("config gateway.remote.url");
    expect(details.bindDetail).toBeUndefined();
    expect(details.remoteFallbackNote).toBeUndefined();
  });

  it("uses env OPENCLAW_GATEWAY_URL when set", () => {
    loadConfig.mockReturnValue({ gateway: { bind: "loopback", mode: "local" } });
    resolveGatewayPort.mockReturnValue(18_800);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    const prevUrl = process.env.OPENCLAW_GATEWAY_URL;
    try {
      process.env.OPENCLAW_GATEWAY_URL = "wss://browser-gateway.local:9443/ws";

      const details = buildGatewayConnectionDetails();

      expect(details.url).toBe("wss://browser-gateway.local:9443/ws");
      expect(details.urlSource).toBe("env OPENCLAW_GATEWAY_URL");
      expect(details.bindDetail).toBeUndefined();
    } finally {
      if (prevUrl === undefined) {
        delete process.env.OPENCLAW_GATEWAY_URL;
      } else {
        process.env.OPENCLAW_GATEWAY_URL = prevUrl;
      }
    }
  });

  it("falls back to the default config loader when test deps drift", () => {
    const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-call-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    process.env.OPENCLAW_CONFIG_PATH = path.join(tempStateDir, "missing-config.json");
    try {
      loadConfig.mockReturnValue({ gateway: { bind: "loopback", mode: "local" } });
      resolveGatewayPort.mockReturnValue(18_800);
      __testing.setDepsForTests({
        loadConfig: {} as never,
        resolveGatewayPort: () => 18_789,
      });

      const details = buildGatewayConnectionDetails();

      expect(details.url).toBe("ws://127.0.0.1:18789");
      expect(details.urlSource).toBe("local loopback");
    } finally {
      fs.rmSync(tempStateDir, { force: true, recursive: true });
    }
  });

  it("throws for insecure ws:// remote URLs (CWE-319)", () => {
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        mode: "remote",
        remote: { url: "ws://remote.example.com:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18_789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);

    let thrown: unknown;
    try {
      buildGatewayConnectionDetails();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("SECURITY ERROR");
    expect((thrown as Error).message).toContain("plaintext ws://");
    expect((thrown as Error).message).toContain("wss://");
    expect((thrown as Error).message).toContain("Tailscale Serve/Funnel");
    expect((thrown as Error).message).toContain("openclaw doctor --fix");
  });

  it("allows ws:// private remote URLs only when OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        mode: "remote",
        remote: { url: "ws://10.0.0.8:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18_789);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://10.0.0.8:18789");
    expect(details.urlSource).toBe("config gateway.remote.url");
  });

  it("allows ws:// hostname remote URLs when OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1", () => {
    process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = "1";
    loadConfig.mockReturnValue({
      gateway: {
        bind: "loopback",
        mode: "remote",
        remote: { url: "ws://openclaw-gateway.ai:18789" },
      },
    });
    resolveGatewayPort.mockReturnValue(18_789);

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://openclaw-gateway.ai:18789");
    expect(details.urlSource).toBe("config gateway.remote.url");
  });

  it("allows ws:// for loopback addresses in local mode", () => {
    setLocalLoopbackGatewayConfig();

    const details = buildGatewayConnectionDetails();

    expect(details.url).toBe("ws://127.0.0.1:18789");
  });
});

describe("callGateway error details", () => {
  beforeEach(() => {
    resetGatewayCallMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes connection details when the gateway closes", async () => {
    startMode = "close";
    closeCode = 1006;
    closeReason = "";
    setLocalLoopbackGatewayConfig();

    let err: Error | null = null;
    try {
      await callGateway({ method: "health" });
    } catch (error) {
      err = error as Error;
    }

    expect(err?.message).toContain("gateway closed (1006");
    expect(err?.message).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(err?.message).toContain("Source: local loopback");
    expect(err?.message).toContain("Bind: loopback");
  });

  it("includes connection details on timeout", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 5 }).catch((error) => {
      errMessage = error instanceof Error ? error.message : String(error);
    });

    await vi.advanceTimersByTimeAsync(5);
    await promise;

    expect(errMessage).toContain("gateway timeout after 5ms");
    expect(errMessage).toContain("Gateway target: ws://127.0.0.1:18789");
    expect(errMessage).toContain("Source: local loopback");
    expect(errMessage).toContain("Bind: loopback");
  });

  it("does not overflow very large timeout values", async () => {
    startMode = "silent";
    setLocalLoopbackGatewayConfig();

    vi.useFakeTimers();
    let errMessage = "";
    const promise = callGateway({ method: "health", timeoutMs: 2_592_010_000 }).catch((error) => {
      errMessage = error instanceof Error ? error.message : String(error);
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(errMessage).toBe("");

    lastClientOptions?.onClose?.(1006, "");
    await promise;

    expect(errMessage).toContain("gateway closed (1006");
  });

  it("forwards caller timeout to client requests", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ method: "health", timeoutMs: 45_000 });

    expect(lastRequestOptions?.method).toBe("health");
    expect(lastRequestOptions?.opts?.timeoutMs).toBe(45_000);
  });

  it("does not inject wrapper timeout defaults into expectFinal requests", async () => {
    setLocalLoopbackGatewayConfig();

    await callGateway({ expectFinal: true, method: "health" });

    expect(lastRequestOptions?.method).toBe("health");
    expect(lastRequestOptions?.opts?.expectFinal).toBe(true);
    expect(lastRequestOptions?.opts?.timeoutMs).toBeUndefined();
  });

  it("fails fast when remote mode is missing remote url", async () => {
    loadConfig.mockReturnValue({
      gateway: { bind: "loopback", mode: "remote", remote: {} },
    });
    await expect(
      callGateway({
        method: "health",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("gateway remote mode misconfigured");
  });

  it("fails before request when a required gateway method is missing", async () => {
    setLocalLoopbackGatewayConfig();
    helloMethods = ["health"];
    await expect(
      callGateway({
        method: "secrets.resolve",
        requiredMethods: ["secrets.resolve"],
      }),
    ).rejects.toThrow(/does not support required method "secrets\.resolve"/i);
  });
});

describe("callGateway url override auth requirements", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_URL",
    ]);
    resetGatewayCallMocks();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_URL;
    setGatewayNetworkDefaults(18_789);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("throws when url override is set without explicit credentials", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "env-password";
    loadConfig.mockReturnValue({
      gateway: {
        auth: { password: "local-password", token: "local-token" },
        mode: "local",
      },
    });

    await expect(
      callGateway({ method: "health", url: "wss://override.example/ws" }),
    ).rejects.toThrow("explicit credentials");
  });

  it("throws when env URL override is set without env credentials", async () => {
    process.env.OPENCLAW_GATEWAY_URL = "wss://override.example/ws";
    loadConfig.mockReturnValue({
      gateway: {
        auth: { password: "local-password", token: "local-token" },
        mode: "local",
      },
    });

    await expect(callGateway({ method: "health" })).rejects.toThrow("explicit credentials");
  });
});

describe("callGateway password resolution", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  const explicitAuthCases = [
    {
      label: "password",
      authKey: "password", // Pragma: allowlist secret
      envKey: "OPENCLAW_GATEWAY_PASSWORD",
      envValue: "from-env",
      configValue: "from-config",
      explicitValue: "explicit-password",
    },
    {
      label: "token",
      authKey: "token", // Pragma: allowlist secret
      envKey: "OPENCLAW_GATEWAY_TOKEN",
      envValue: "env-token",
      configValue: "local-token",
      explicitValue: "explicit-token",
    },
  ] as const;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_TOKEN",
      "LOCAL_REMOTE_FALLBACK_TOKEN",
      "LOCAL_REF_PASSWORD",
      "REMOTE_REF_TOKEN",
      "REMOTE_REF_PASSWORD",
    ]);
    resetGatewayCallMocks();
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.LOCAL_REMOTE_FALLBACK_TOKEN;
    delete process.env.LOCAL_REF_PASSWORD;
    delete process.env.REMOTE_REF_TOKEN;
    delete process.env.REMOTE_REF_PASSWORD;
    setGatewayNetworkDefaults(18_789);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it.each([
    {
      config: {
        gateway: {
          auth: { password: "secret" },
          bind: "loopback",
          mode: "local",
        },
      },
      envPassword: undefined,
      expectedPassword: "secret",
      label: "uses local config password when env is unset",
    },
    {
      config: {
        gateway: {
          auth: { password: "from-config" },
          bind: "loopback",
          mode: "local",
        },
      },
      envPassword: "from-env",
      expectedPassword: "from-env",
      label: "prefers env password over local config password",
    },
    {
      config: makeRemotePasswordGatewayConfig("remote-secret"),
      envPassword: undefined,
      expectedPassword: "remote-secret",
      label: "uses remote password in remote mode when env is unset",
    },
    {
      config: makeRemotePasswordGatewayConfig("remote-secret"),
      envPassword: "from-env",
      expectedPassword: "from-env",
      label: "prefers env password over remote password in remote mode",
    },
  ])("$label", async ({ envPassword, config, expectedPassword }) => {
    if (envPassword !== undefined) {
      process.env.OPENCLAW_GATEWAY_PASSWORD = envPassword;
    }
    loadConfig.mockReturnValue(config);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe(expectedPassword);
  });

  it("resolves gateway.auth.password SecretInput refs for gateway calls", async () => {
    process.env.LOCAL_REF_PASSWORD = "resolved-local-ref-password"; // Pragma: allowlist secret
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "password",
          password: { id: "LOCAL_REF_PASSWORD", provider: "default", source: "env" },
        },
        bind: "loopback",
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("resolved-local-ref-password");
  });

  it("does not resolve local password ref when env password takes precedence", async () => {
    process.env.OPENCLAW_GATEWAY_PASSWORD = "from-env";
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "password",
          password: { id: "MISSING_LOCAL_REF_PASSWORD", provider: "default", source: "env" },
        },
        bind: "loopback",
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("from-env");
  });

  it("does not resolve local password ref when token auth can win", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
          password: { id: "MISSING_LOCAL_REF_PASSWORD", provider: "default", source: "env" },
          token: "token-auth",
        },
        bind: "loopback",
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("token-auth");
  });

  it("resolves local password ref before unresolved local token ref can block auth", async () => {
    process.env.LOCAL_FALLBACK_PASSWORD = "resolved-local-fallback-password"; // Pragma: allowlist secret
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          password: { id: "LOCAL_FALLBACK_PASSWORD", provider: "default", source: "env" },
          token: { id: "MISSING_LOCAL_REF_TOKEN", provider: "default", source: "env" },
        },
        bind: "loopback",
        mode: "local",
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBe("resolved-local-fallback-password"); // Pragma: allowlist secret
  });

  it("fails closed when unresolved local token SecretRef would otherwise fall back to remote token", async () => {
    process.env.LOCAL_REMOTE_FALLBACK_TOKEN = "resolved-local-remote-fallback-token";
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "token",
          token: { id: "MISSING_LOCAL_REF_TOKEN", provider: "default", source: "env" },
        },
        bind: "loopback",
        mode: "local",
        remote: {
          token: { id: "LOCAL_REMOTE_FALLBACK_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await expect(callGateway({ method: "health" })).rejects.toThrow("gateway.auth.token");
  });

  it.each(["none", "trusted-proxy"] as const)(
    "ignores unresolved local password ref when auth mode is %s",
    async (mode) => {
      loadConfig.mockReturnValue({
        gateway: {
          auth: {
            mode,
            password: { id: "MISSING_LOCAL_REF_PASSWORD", provider: "default", source: "env" },
          },
          bind: "loopback",
          mode: "local",
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig);

      await callGateway({ method: "health" });

      expect(lastClientOptions?.token).toBeUndefined();
      expect(lastClientOptions?.password).toBeUndefined();
    },
  );

  it("does not resolve local password ref when remote password is already configured", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {
          mode: "password",
          password: { id: "MISSING_LOCAL_REF_PASSWORD", provider: "default", source: "env" },
        },
        bind: "loopback",
        mode: "remote",
        remote: {
          password: "remote-secret",
          url: "wss://remote.example:18789",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("remote-secret");
  });

  it("resolves gateway.remote.token SecretInput refs when remote token is required", async () => {
    process.env.REMOTE_REF_TOKEN = "resolved-remote-ref-token";
    loadConfig.mockReturnValue({
      gateway: {
        auth: {},
        bind: "loopback",
        mode: "remote",
        remote: {
          token: { id: "REMOTE_REF_TOKEN", provider: "default", source: "env" },
          url: "wss://remote.example:18789",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("resolved-remote-ref-token");
  });

  it("resolves gateway.remote.password SecretInput refs when remote password is required", async () => {
    process.env.REMOTE_REF_PASSWORD = "resolved-remote-ref-password"; // Pragma: allowlist secret
    loadConfig.mockReturnValue({
      gateway: {
        auth: {},
        bind: "loopback",
        mode: "remote",
        remote: {
          password: { id: "REMOTE_REF_PASSWORD", provider: "default", source: "env" },
          url: "wss://remote.example:18789",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.password).toBe("resolved-remote-ref-password");
  });

  it("does not resolve remote token ref when remote password already wins", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {},
        bind: "loopback",
        mode: "remote",
        remote: {
          password: "remote-password",
          token: { id: "MISSING_REMOTE_TOKEN", provider: "default", source: "env" },
          url: "wss://remote.example:18789", // Pragma: allowlist secret
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBeUndefined();
    expect(lastClientOptions?.password).toBe("remote-password");
  });

  it("resolves remote token ref before unresolved remote password ref can block auth", async () => {
    process.env.REMOTE_REF_TOKEN = "resolved-remote-ref-token";
    loadConfig.mockReturnValue({
      gateway: {
        auth: {},
        bind: "loopback",
        mode: "remote",
        remote: {
          password: { id: "MISSING_REMOTE_PASSWORD", provider: "default", source: "env" },
          token: { id: "REMOTE_REF_TOKEN", provider: "default", source: "env" },
          url: "wss://remote.example:18789",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("resolved-remote-ref-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("does not resolve remote password ref when remote token already wins", async () => {
    loadConfig.mockReturnValue({
      gateway: {
        auth: {},
        bind: "loopback",
        mode: "remote",
        remote: {
          password: { id: "MISSING_REMOTE_PASSWORD", provider: "default", source: "env" },
          token: "remote-token",
          url: "wss://remote.example:18789",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("remote-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it("resolves remote token refs on local-mode calls when fallback token can win", async () => {
    process.env.LOCAL_FALLBACK_REMOTE_TOKEN = "resolved-local-fallback-remote-token";
    loadConfig.mockReturnValue({
      gateway: {
        auth: {},
        bind: "loopback",
        mode: "local",
        remote: {
          password: { id: "MISSING_REMOTE_PASSWORD", provider: "default", source: "env" },
          token: { id: "LOCAL_FALLBACK_REMOTE_TOKEN", provider: "default", source: "env" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig);

    await callGateway({ method: "health" });

    expect(lastClientOptions?.token).toBe("resolved-local-fallback-remote-token");
    expect(lastClientOptions?.password).toBeUndefined();
  });

  it.each(["none", "trusted-proxy"] as const)(
    "does not resolve remote refs on non-remote gateway calls when auth mode is %s",
    async (mode) => {
      loadConfig.mockReturnValue({
        gateway: {
          auth: { mode },
          bind: "loopback",
          mode: "local",
          remote: {
            password: { id: "MISSING_REMOTE_PASSWORD", provider: "default", source: "env" },
            token: { id: "MISSING_REMOTE_TOKEN", provider: "default", source: "env" },
            url: "wss://remote.example:18789",
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig);

      await callGateway({ method: "health" });

      expect(lastClientOptions?.token).toBeUndefined();
      expect(lastClientOptions?.password).toBeUndefined();
    },
  );

  it.each(explicitAuthCases)("uses explicit $label when url override is set", async (testCase) => {
    process.env[testCase.envKey] = testCase.envValue;
    const auth = { [testCase.authKey]: testCase.configValue } as {
      password?: string;
      token?: string;
    };
    loadConfig.mockReturnValue({
      gateway: {
        auth,
        mode: "local",
      },
    });

    await callGateway({
      method: "health",
      url: "wss://override.example/ws",
      [testCase.authKey]: testCase.explicitValue,
    });

    expect(lastClientOptions?.[testCase.authKey]).toBe(testCase.explicitValue);
  });
});
