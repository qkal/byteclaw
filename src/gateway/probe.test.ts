import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayClientState = vi.hoisted(() => ({
  close: { code: 1008, reason: "pairing required" },
  options: null as Record<string, unknown> | null,
  requests: [] as string[],
  startMode: "hello" as "hello" | "close",
}));

const deviceIdentityState = vi.hoisted(() => ({
  throwOnLoad: false,
  value: { id: "test-device-identity" } as Record<string, unknown>,
}));

class MockGatewayClient {
  private readonly opts: Record<string, unknown>;

  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    gatewayClientState.options = opts;
    gatewayClientState.requests = [];
  }

  start(): void {
    void Promise.resolve()
      .then(async () => {
        if (gatewayClientState.startMode === "close") {
          const {onClose} = this.opts;
          if (typeof onClose === "function") {
            onClose(gatewayClientState.close.code, gatewayClientState.close.reason);
          }
          return;
        }
        const {onHelloOk} = this.opts;
        if (typeof onHelloOk === "function") {
          await onHelloOk();
        }
      })
      .catch(() => {});
  }

  stop(): void {}

  async request(method: string): Promise<unknown> {
    gatewayClientState.requests.push(method);
    if (method === "system-presence") {
      return [];
    }
    return {};
  }
}

vi.mock("./client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => {
    if (deviceIdentityState.throwOnLoad) {
      throw new Error("read-only identity dir");
    }
    return deviceIdentityState.value;
  },
}));

const { clampProbeTimeoutMs, probeGateway } = await import("./probe.js");

describe("probeGateway", () => {
  beforeEach(() => {
    deviceIdentityState.throwOnLoad = false;
    gatewayClientState.startMode = "hello";
    gatewayClientState.close = { code: 1008, reason: "pairing required" };
  });

  it("clamps probe timeout to timer-safe bounds", () => {
    expect(clampProbeTimeoutMs(1)).toBe(250);
    expect(clampProbeTimeoutMs(2000)).toBe(2000);
    expect(clampProbeTimeoutMs(3_000_000_000)).toBe(2_147_483_647);
  });
  it("connects with operator.read scope", async () => {
    const result = await probeGateway({
      auth: { token: "secret" },
      timeoutMs: 1000,
      url: "ws://127.0.0.1:18789",
    });

    expect(gatewayClientState.options?.scopes).toEqual(["operator.read"]);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
    expect(result.ok).toBe(true);
  });

  it("keeps device identity enabled for remote probes", async () => {
    await probeGateway({
      auth: { token: "secret" },
      timeoutMs: 1000,
      url: "wss://gateway.example/ws",
    });

    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
  });

  it("keeps device identity disabled for unauthenticated loopback probes", async () => {
    await probeGateway({
      timeoutMs: 1000,
      url: "ws://127.0.0.1:18789",
    });

    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
  });

  it("skips detail RPCs for lightweight reachability probes", async () => {
    const result = await probeGateway({
      includeDetails: false,
      timeoutMs: 1000,
      url: "ws://127.0.0.1:18789",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("keeps device identity enabled for authenticated lightweight probes", async () => {
    const result = await probeGateway({
      auth: { token: "secret" },
      includeDetails: false,
      timeoutMs: 1000,
      url: "ws://127.0.0.1:18789",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toEqual(deviceIdentityState.value);
    expect(gatewayClientState.requests).toEqual([]);
  });

  it("falls back to token/password auth when device identity cannot be persisted", async () => {
    deviceIdentityState.throwOnLoad = true;

    const result = await probeGateway({
      auth: { token: "secret" },
      timeoutMs: 1000,
      url: "ws://127.0.0.1:18789",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.options?.deviceIdentity).toBeNull();
    expect(gatewayClientState.requests).toEqual([
      "health",
      "status",
      "system-presence",
      "config.get",
    ]);
  });

  it("fetches only presence for presence-only probes", async () => {
    const result = await probeGateway({
      detailLevel: "presence",
      timeoutMs: 1000,
      url: "ws://127.0.0.1:18789",
    });

    expect(result.ok).toBe(true);
    expect(gatewayClientState.requests).toEqual(["system-presence"]);
    expect(result.health).toBeNull();
    expect(result.status).toBeNull();
    expect(result.configSnapshot).toBeNull();
  });

  it("passes through tls fingerprints for secure daemon probes", async () => {
    await probeGateway({
      auth: { token: "secret" },
      includeDetails: false,
      timeoutMs: 1000,
      tlsFingerprint: "sha256:abc",
      url: "wss://gateway.example/ws",
    });

    expect(gatewayClientState.options?.tlsFingerprint).toBe("sha256:abc");
  });

  it("surfaces immediate close failures before the probe timeout", async () => {
    gatewayClientState.startMode = "close";

    const result = await probeGateway({
      auth: { token: "secret" },
      includeDetails: false,
      timeoutMs: 5000,
      url: "ws://127.0.0.1:18789",
    });

    expect(result).toMatchObject({
      close: { code: 1008, reason: "pairing required" },
      error: "gateway closed (1008): pairing required",
      ok: false,
    });
    expect(gatewayClientState.requests).toEqual([]);
  });
});
