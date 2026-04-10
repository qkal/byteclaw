import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { nodeHandlers } from "./nodes.js";

describe("node.canvas.capability.refresh", () => {
  it("rotates the caller canvas capability and returns a fresh scoped URL", async () => {
    const respond = vi.fn();
    const client = {
      canvasCapability: "old-token",
      canvasCapabilityExpiresAtMs: Date.now() - 1,
      canvasHostUrl: "http://127.0.0.1:18789",
      connect: { client: { id: "node-1" }, role: "node" },
    };

    await nodeHandlers["node.canvas.capability.refresh"]({
      client: client as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "req-1", method: "node.canvas.capability.refresh", type: "req" },
      respond,
    });

    const call = respond.mock.calls[0] as
      | [
          boolean,
          {
            canvasCapability?: string;
            canvasHostUrl?: string;
            canvasCapabilityExpiresAtMs?: number;
          },
        ]
      | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] ?? {};
    expect(typeof payload.canvasCapability).toBe("string");
    expect(payload.canvasCapability).not.toBe("old-token");
    expect(payload.canvasHostUrl).toContain("/__openclaw__/cap/");
    expect(typeof payload.canvasCapabilityExpiresAtMs).toBe("number");
    expect(payload.canvasCapabilityExpiresAtMs).toBeGreaterThan(Date.now());
    expect(client.canvasCapability).toBe(payload.canvasCapability);
    expect(client.canvasCapabilityExpiresAtMs).toBe(payload.canvasCapabilityExpiresAtMs);
  });

  it("returns unavailable when the caller session has no base canvas URL", async () => {
    const respond = vi.fn();

    await nodeHandlers["node.canvas.capability.refresh"]({
      client: { connect: { client: { id: "node-1" }, role: "node" } } as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {},
      req: { id: "req-2", method: "node.canvas.capability.refresh", type: "req" },
      respond,
    });

    const call = respond.mock.calls[0] as
      | [boolean, unknown, { code?: number; message?: string }]
      | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
  });
});
