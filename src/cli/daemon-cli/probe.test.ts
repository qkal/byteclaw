import { describe, expect, it, vi } from "vitest";
import { probeGatewayStatus } from "./probe.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const probeGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (...args: unknown[]) => probeGatewayMock(...args),
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

describe("probeGatewayStatus", () => {
  it("uses lightweight token-only probing for daemon status", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({ ok: true });

    const result = await probeGatewayStatus({
      json: true,
      timeoutMs: 5000,
      tlsFingerprint: "abc123",
      token: "temp-token",
      url: "ws://127.0.0.1:19191",
    });

    expect(result).toEqual({ ok: true });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(probeGatewayMock).toHaveBeenCalledWith({
      auth: {
        password: undefined,
        token: "temp-token",
      },
      includeDetails: false,
      timeoutMs: 5000,
      tlsFingerprint: "abc123",
      url: "ws://127.0.0.1:19191",
    });
  });

  it("uses a real status RPC when requireRpc is enabled", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockResolvedValueOnce({ status: "ok" });

    const result = await probeGatewayStatus({
      configPath: "/tmp/openclaw-daemon/openclaw.json",
      json: true,
      requireRpc: true,
      timeoutMs: 5000,
      tlsFingerprint: "abc123",
      token: "temp-token",
      url: "ws://127.0.0.1:19191",
    });

    expect(result).toEqual({ ok: true });
    expect(probeGatewayMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledWith({
      configPath: "/tmp/openclaw-daemon/openclaw.json",
      method: "status",
      password: undefined,
      timeoutMs: 5000,
      tlsFingerprint: "abc123",
      token: "temp-token",
      url: "ws://127.0.0.1:19191",
    });
  });

  it("surfaces probe close details when the handshake fails", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      close: { code: 1008, reason: "pairing required" },
      error: null,
      ok: false,
    });

    const result = await probeGatewayStatus({
      timeoutMs: 5000,
      url: "ws://127.0.0.1:19191",
    });

    expect(result).toEqual({
      error: "gateway closed (1008): pairing required",
      ok: false,
    });
  });

  it("prefers the close reason over a generic timeout when both are present", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    probeGatewayMock.mockResolvedValueOnce({
      close: { code: 1008, reason: "pairing required" },
      error: "timeout",
      ok: false,
    });

    const result = await probeGatewayStatus({
      timeoutMs: 5000,
      url: "ws://127.0.0.1:19191",
    });

    expect(result).toEqual({
      error: "gateway closed (1008): pairing required",
      ok: false,
    });
  });

  it("surfaces status RPC errors when requireRpc is enabled", async () => {
    callGatewayMock.mockReset();
    probeGatewayMock.mockReset();
    callGatewayMock.mockRejectedValueOnce(new Error("missing scope: operator.admin"));

    const result = await probeGatewayStatus({
      requireRpc: true,
      timeoutMs: 5000,
      token: "temp-token",
      url: "ws://127.0.0.1:19191",
    });

    expect(result).toEqual({
      error: "missing scope: operator.admin",
      ok: false,
    });
    expect(probeGatewayMock).not.toHaveBeenCalled();
  });
});
