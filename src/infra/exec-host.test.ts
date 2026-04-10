import { beforeEach, describe, expect, it, vi } from "vitest";

const requestJsonlSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./jsonl-socket.js", () => ({
  requestJsonlSocket: (...args: unknown[]) => requestJsonlSocketMock(...args),
}));

import { requestExecHostViaSocket } from "./exec-host.js";

describe("requestExecHostViaSocket", () => {
  beforeEach(() => {
    requestJsonlSocketMock.mockReset();
  });

  it("returns null when socket credentials are missing", async () => {
    await expect(
      requestExecHostViaSocket({
        request: { command: ["echo", "hi"] },
        socketPath: "",
        token: "secret",
      }),
    ).resolves.toBeNull();
    await expect(
      requestExecHostViaSocket({
        request: { command: ["echo", "hi"] },
        socketPath: "/tmp/socket",
        token: "",
      }),
    ).resolves.toBeNull();
    expect(requestJsonlSocketMock).not.toHaveBeenCalled();
  });

  it("builds an exec payload and forwards the default timeout", async () => {
    requestJsonlSocketMock.mockResolvedValueOnce({ ok: true, payload: { success: true } });

    await expect(
      requestExecHostViaSocket({
        request: {
          command: ["echo", "hi"],
          cwd: "/tmp",
        },
        socketPath: "/tmp/socket",
        token: "secret",
      }),
    ).resolves.toEqual({ ok: true, payload: { success: true } });

    const call = requestJsonlSocketMock.mock.calls[0]?.[0] as
      | {
          socketPath: string;
          requestLine: string;
          timeoutMs: number;
          accept: (msg: unknown) => unknown;
        }
      | undefined;
    if (!call) {
      throw new Error("expected requestJsonlSocket call");
    }

    expect(call.socketPath).toBe("/tmp/socket");
    expect(call.timeoutMs).toBe(20_000);
    const payload = JSON.parse(call.requestLine) as {
      type: string;
      id: string;
      nonce: string;
      ts: number;
      hmac: string;
      requestJson: string;
    };
    expect(payload.type).toBe("exec");
    expect(payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof payload.ts).toBe("number");
    expect(payload.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(payload.requestJson)).toEqual({
      command: ["echo", "hi"],
      cwd: "/tmp",
    });
  });

  it("accepts only exec response messages and maps malformed matches to null", async () => {
    requestJsonlSocketMock.mockImplementationOnce(async ({ accept }) => {
      expect(accept({ type: "ignore" })).toBeUndefined();
      expect(accept({ ok: true, payload: { success: true }, type: "exec-res" })).toEqual({
        ok: true,
        payload: { success: true },
      });
      expect(accept({ error: { code: "DENIED" }, ok: false, type: "exec-res" })).toEqual({
        error: { code: "DENIED" },
        ok: false,
      });
      expect(accept({ ok: true, type: "exec-res" })).toBeNull();
      return null;
    });

    await expect(
      requestExecHostViaSocket({
        request: { command: ["echo", "hi"] },
        socketPath: "/tmp/socket",
        timeoutMs: 123,
        token: "secret",
      }),
    ).resolves.toBeNull();

    expect(
      (requestJsonlSocketMock.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined)?.timeoutMs,
    ).toBe(123);
  });
});
