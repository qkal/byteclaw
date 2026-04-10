import { describe, expect, it, vi } from "vitest";
import {
  logGatewayConnectionDetails,
  resolveStatusAllConnectionDetails,
} from "./status.gateway-connection.js";

describe("status.gateway-connection", () => {
  it("logs gateway connection details with indentation", () => {
    const runtime = { log: vi.fn() };

    logGatewayConnectionDetails({
      info: (value) => `info:${value}`,
      message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
      runtime,
      trailingBlankLine: true,
    });

    expect(runtime.log.mock.calls).toEqual([
      ["info:Gateway connection:"],
      ["  Gateway mode: local"],
      ["  Gateway target: ws://127.0.0.1:18789"],
      [""],
    ]);
  });

  it("builds remote fallback connection details", () => {
    expect(
      resolveStatusAllConnectionDetails({
        bindMode: "loopback",
        configPath: "/tmp/openclaw.json",
        gatewayConnection: {
          message: "ignored",
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
        },
        nodeOnlyGateway: null,
        remoteUrlMissing: true,
      }),
    ).toContain("Local fallback (used for probes): ws://127.0.0.1:18789");
  });

  it("prefers node-only connection details when present", () => {
    expect(
      resolveStatusAllConnectionDetails({
        bindMode: "loopback",
        configPath: "/tmp/openclaw.json",
        gatewayConnection: {
          message: "Gateway mode: local",
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
        },
        nodeOnlyGateway: {
          connectionDetails: "Node-only mode detected",
          gatewayTarget: "remote.example:18789",
          gatewayValue: "node → remote.example:18789 · no local gateway",
        },
        remoteUrlMissing: false,
      }),
    ).toBe("Node-only mode detected");
  });
});
