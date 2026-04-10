import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import type { PortListenerKind, PortUsage } from "../../infra/ports.js";

const inspectPortUsage = vi.hoisted(() => vi.fn<(port: number) => Promise<PortUsage>>());
const sleep = vi.hoisted(() => vi.fn(async (_ms: number) => {}));
const classifyPortListener = vi.hoisted(() =>
  vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(() => "gateway"),
);
const probeGateway = vi.hoisted(() => vi.fn());

vi.mock("../../infra/ports.js", () => ({
  classifyPortListener: (listener: unknown, port: number) => classifyPortListener(listener, port),
  formatPortDiagnostics: vi.fn(() => []),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleep(ms),
  };
});

const originalPlatform = process.platform;

function makeGatewayService(
  runtime: { status: "running"; pid: number } | { status: "stopped" },
): GatewayService {
  return {
    readRuntime: vi.fn(async () => runtime),
  } as unknown as GatewayService;
}

async function inspectGatewayRestartWithSnapshot(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  portUsage: PortUsage;
  includeUnknownListenersAsStale?: boolean;
}) {
  const service = makeGatewayService(params.runtime);
  inspectPortUsage.mockResolvedValue(params.portUsage);
  const { inspectGatewayRestart } = await import("./restart-health.js");
  return inspectGatewayRestart({
    port: 18_789,
    service,
    ...(params.includeUnknownListenersAsStale === undefined
      ? {}
      : { includeUnknownListenersAsStale: params.includeUnknownListenersAsStale }),
  });
}

async function inspectUnknownListenerFallback(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  includeUnknownListenersAsStale: boolean;
}) {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  classifyPortListener.mockReturnValue("unknown");
  return inspectGatewayRestartWithSnapshot({
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
    portUsage: {
      hints: [],
      listeners: [{ command: "unknown", pid: 10920 }],
      port: 18_789,
      status: "busy",
    },
    runtime: params.runtime,
  });
}

async function inspectAmbiguousOwnershipWithProbe(
  probeResult: Awaited<ReturnType<typeof probeGateway>>,
) {
  classifyPortListener.mockReturnValue("unknown");
  probeGateway.mockResolvedValue(probeResult);
  return inspectGatewayRestartWithSnapshot({
    portUsage: {
      hints: [],
      listeners: [{ commandLine: "" }],
      port: 18_789,
      status: "busy",
    },
    runtime: { pid: 8000, status: "running" },
  });
}

describe("inspectGatewayRestart", () => {
  beforeEach(() => {
    inspectPortUsage.mockReset();
    inspectPortUsage.mockResolvedValue({
      hints: [],
      listeners: [],
      port: 0,
      status: "free",
    });
    sleep.mockReset();
    classifyPortListener.mockReset();
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockReset();
    probeGateway.mockResolvedValue({
      close: null,
      ok: false,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("treats a gateway listener child pid as healthy ownership", async () => {
    const snapshot = await inspectGatewayRestartWithSnapshot({
      portUsage: {
        hints: [],
        listeners: [{ commandLine: "openclaw-gateway", pid: 7001, ppid: 7000 }],
        port: 18_789,
        status: "busy",
      },
      runtime: { pid: 7000, status: "running" },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("marks non-owned gateway listener pids as stale while runtime is running", async () => {
    const snapshot = await inspectGatewayRestartWithSnapshot({
      portUsage: {
        hints: [],
        listeners: [{ commandLine: "openclaw-gateway", pid: 9000, ppid: 8999 }],
        port: 18_789,
        status: "busy",
      },
      runtime: { pid: 8000, status: "running" },
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.staleGatewayPids).toEqual([9000]);
  });

  it("treats unknown listeners as stale on Windows when enabled", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      includeUnknownListenersAsStale: true,
      runtime: { status: "stopped" },
    });

    expect(snapshot.staleGatewayPids).toEqual([10_920]);
  });

  it("does not treat unknown listeners as stale when fallback is disabled", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      includeUnknownListenersAsStale: false,
      runtime: { status: "stopped" },
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not apply unknown-listener fallback while runtime is running", async () => {
    const snapshot = await inspectUnknownListenerFallback({
      includeUnknownListenersAsStale: true,
      runtime: { pid: 10_920, status: "running" },
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not treat known non-gateway listeners as stale in fallback mode", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    classifyPortListener.mockReturnValue("ssh");

    const snapshot = await inspectGatewayRestartWithSnapshot({
      includeUnknownListenersAsStale: true,
      portUsage: {
        hints: [],
        listeners: [{ command: "nginx.exe", pid: 22001 }],
        port: 18_789,
        status: "busy",
      },
      runtime: { status: "stopped" },
    });

    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("uses a local gateway probe when ownership is ambiguous", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe({
      close: null,
      ok: true,
    });

    expect(snapshot.healthy).toBe(true);
    expect(probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
  });

  it("treats a busy port as healthy when runtime status lags but the probe succeeds", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    classifyPortListener.mockReturnValue("gateway");
    probeGateway.mockResolvedValue({
      close: null,
      ok: true,
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      portUsage: {
        hints: [],
        listeners: [{ commandLine: "openclaw-gateway", pid: 9100 }],
        port: 18_789,
        status: "busy",
      },
      runtime: { status: "stopped" },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("treats auth-closed probe as healthy gateway reachability", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe({
      close: { code: 1008, reason: "auth required" },
      ok: false,
    });

    expect(snapshot.healthy).toBe(true);
  });

  it("treats busy ports with unavailable listener details as healthy when runtime is running", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ pid: 8000, status: "running" })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      errors: ["Error: spawn lsof ENOENT"],
      hints: [
        "Port is in use but process details are unavailable (install lsof or run as an admin user).",
      ],
      listeners: [],
      port: 18_789,
      status: "busy",
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ port: 18_789, service });

    expect(snapshot.healthy).toBe(true);
    expect(probeGateway).not.toHaveBeenCalled();
  });

  it("annotates stopped-free early exits with the actual elapsed time", async () => {
    const service = makeGatewayService({ status: "stopped" });
    inspectPortUsage.mockResolvedValue({
      hints: [],
      listeners: [],
      port: 18_789,
      status: "free",
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      attempts: 120,
      delayMs: 500,
      port: 18_789,
      service,
    });

    expect(snapshot).toMatchObject({
      elapsedMs: 12_500,
      healthy: false,
      portUsage: { status: "free" },
      runtime: { status: "stopped" },
      waitOutcome: "stopped-free",
    });
    expect(sleep).toHaveBeenCalledTimes(25);
  });

  it("waits longer before stopped-free early exit on Windows", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const service = makeGatewayService({ status: "stopped" });
    inspectPortUsage.mockResolvedValue({
      hints: [],
      listeners: [],
      port: 18_789,
      status: "free",
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      attempts: 120,
      delayMs: 500,
      port: 18_789,
      service,
    });

    expect(snapshot).toMatchObject({
      elapsedMs: 27_500,
      healthy: false,
      portUsage: { status: "free" },
      runtime: { status: "stopped" },
      waitOutcome: "stopped-free",
    });
    expect(sleep).toHaveBeenCalledTimes(55);
  });

  it("annotates timeout waits when the health loop exhausts all attempts", async () => {
    const service = makeGatewayService({ pid: 8000, status: "running" });
    inspectPortUsage.mockResolvedValue({
      hints: [],
      listeners: [],
      port: 18_789,
      status: "free",
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      attempts: 4,
      delayMs: 1000,
      port: 18_789,
      service,
    });

    expect(snapshot).toMatchObject({
      elapsedMs: 4000,
      healthy: false,
      portUsage: { status: "free" },
      runtime: { pid: 8000, status: "running" },
      waitOutcome: "timeout",
    });
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
